# Research Report: mem0 & Agent Memory Systems

**Date**: 2026-03-07
**Sources**: mem0ai/mem0 source code (Python + TypeScript), architecture analysis, prompt engineering review

---

## Executive Summary

mem0 is an **LLM-powered fact extraction + vector search** system. Its core insight is dead simple: use an LLM to extract atomic facts from conversations, embed them into vectors, then use a second LLM call to decide ADD/UPDATE/DELETE against existing memories. There is no system called "memU" — the user likely meant mem0 or MemGPT/Letta. 

**Key takeaway for a no-external-deps implementation**: mem0's two-LLM-call pattern (extract facts → reconcile with existing) is the gold standard pattern. But the vector search component can be replaced with SQLite FTS5 + recency scoring for a zero-dependency approach that gets you 80% of the value.

---

## Table of Contents
1. [mem0 Architecture Deep Dive](#1-mem0-architecture-deep-dive)
2. [Other Memory Systems (Letta/MemGPT, Zep)](#2-other-memory-systems)
3. [Key Design Patterns](#3-key-design-patterns)
4. [Simple Implementation Without External Deps](#4-simple-implementation)
5. [Recommendations](#5-recommendations)

---

## 1. mem0 Architecture Deep Dive

### 1.1 Data Flow (the `add()` pipeline)

```
Conversation Messages
        │
        ▼
┌─────────────────────┐
│  LLM Call #1:       │  "Extract facts from this conversation"
│  Fact Extraction    │  → Returns JSON: {"facts": ["Name is John", "Likes pizza"]}
└─────────┬───────────┘
          │
          ▼  (for each extracted fact)
┌─────────────────────┐
│  Vector Search      │  Embed fact → search existing memories
│  Find Similar       │  → Returns top-5 similar existing memories
└─────────┬───────────┘
          │
          ▼
┌─────────────────────┐
│  LLM Call #2:       │  "Given old memories + new facts, decide:"
│  Memory Reconciler  │   ADD / UPDATE / DELETE / NONE for each
└─────────┬───────────┘
          │
          ▼
┌─────────────────────┐
│  Execute Actions    │  Create/update/delete in vector store
│  + History Log      │  Log changes in SQLite history table
└─────────────────────┘
```

**This is the entire system.** Two LLM calls + vector search + SQLite history. That's it.

### 1.2 Memory Types

mem0 supports 3 memory types, but only 2 are meaningfully different:

| Type | What | How |
|------|------|-----|
| **Semantic/Episodic** (default) | Facts extracted from user messages | LLM extraction → vector store. User preferences, personal details, plans, etc. |
| **Agent Memory** | Facts about the assistant itself | Same pipeline, different extraction prompt (focuses on assistant messages instead of user messages) |
| **Procedural** | Step-by-step execution history | Full conversation → LLM summarization → single vector. Used for task replay/continuation. |

**Important**: "episodic" and "semantic" are NOT separate systems. They're the same pipeline. The distinction is marketing. All facts go into the same vector store with the same metadata.

### 1.3 Fact Extraction Prompts (the real magic)

The extraction prompt is a few-shot classifier. Key elements:

```
CATEGORIES:
1. Personal Preferences (likes, dislikes)
2. Important Personal Details (names, relationships, dates)
3. Plans and Intentions (events, trips, goals)
4. Activity/Service Preferences (dining, travel, hobbies)
5. Health/Wellness Preferences
6. Professional Details (job, career goals)
7. Miscellaneous (favorites, brands)

FEW-SHOT EXAMPLES:
Input: "Hi."
Output: {"facts": []}

Input: "Hi, I am looking for a restaurant in San Francisco."
Output: {"facts": ["Looking for a restaurant in San Francisco"]}

Input: "Hi, my name is John. I am a software engineer."
Output: {"facts": ["Name is John", "Is a Software engineer"]}
```

**Critical detail**: The user extraction prompt explicitly says `GENERATE FACTS SOLELY BASED ON THE USER'S MESSAGES. DO NOT INCLUDE INFORMATION FROM ASSISTANT OR SYSTEM MESSAGES.` — repeated twice with penalty threats. The agent extraction prompt mirrors this for assistant messages.

### 1.4 Memory Reconciliation (LLM Call #2)

The `DEFAULT_UPDATE_MEMORY_PROMPT` is the second key prompt. It receives:
- **Old memories**: List of `{id, text}` from vector search
- **New facts**: List of extracted facts

It decides for each: `ADD`, `UPDATE`, `DELETE`, or `NONE`.

**Clever trick**: UUIDs are replaced with sequential integers (0, 1, 2...) before sending to LLM to prevent UUID hallucinations. Mapped back after response.

```json
// Output format:
{
  "memory": [
    {"id": "0", "text": "Loves cheese and chicken pizza", "event": "UPDATE", "old_memory": "I really like cheese pizza"},
    {"id": "1", "text": "User is a software engineer", "event": "NONE"},
    {"id": "2", "text": "Name is John", "event": "ADD"}
  ]
}
```

### 1.5 Scoping Model

Three scope dimensions, stored as metadata on each vector:

| Scope | Field | Purpose |
|-------|-------|---------|
| **User** | `user_id` | Per-user memories (preferences, profile) |
| **Agent** | `agent_id` | Per-agent memories (agent's own personality/knowledge) |
| **Session** | `run_id` | Per-session/conversation memories (ephemeral context) |

At least ONE must be provided. They're stored as metadata on vectors and used as filters during search. Multiple scopes can be combined (e.g., `user_id=X AND agent_id=Y` returns memories specific to that user-agent pair).

### 1.6 Search/Retrieval

```python
def search(query, user_id, limit=100, threshold=None):
    # 1. Embed the query
    embeddings = embedding_model.embed(query)
    
    # 2. Vector similarity search with metadata filters
    memories = vector_store.search(
        query=query, vectors=embeddings, 
        limit=limit, filters={"user_id": user_id}
    )
    
    # 3. Optional: rerank results
    if reranker:
        memories = reranker.rerank(query, memories, limit)
    
    # 4. Optional: graph search (BM25 reranking of entity triples)
    if enable_graph:
        graph_results = graph.search(query, filters, limit)
    
    return memories
```

### 1.7 Storage Backend

- **Vector Store**: Default Qdrant (27 backends supported: Qdrant, ChromaDB, Pinecone, pgvector, FAISS, Redis, Milvus, Weaviate, etc.)
- **History**: SQLite (always, for change tracking)
- **Graph**: Optional Neo4j (for entity relationships)
- **TS "memory" provider**: SQLite + brute-force cosine similarity (no real vector index)

### 1.8 Graph Memory (Optional)

When enabled, runs in parallel with vector store:
1. LLM extracts entities + relationships from text
2. Stores as triples in Neo4j: `source -- RELATIONSHIP -- destination`
3. Search uses BM25 (Okapi) reranking on entity triples
4. Separate prompts for graph updates, deletions, relation extraction

**Verdict**: Graph memory is a nice-to-have for relationship-heavy domains. Adds Neo4j dependency. Not worth it for most use cases.

### 1.9 Key Insight

**What makes mem0 work well**: The two-phase LLM approach.

Phase 1 (extraction) converts messy conversations into **atomic, self-contained facts**.
Phase 2 (reconciliation) handles **deduplication, updates, and contradictions** by comparing new facts against retrieved similar ones.

This means the memory store stays clean — no duplicate facts, outdated info gets updated, contradictions get resolved. The LLM does the hard semantic work that would be impossible with rules alone.

---

## 2. Other Memory Systems

### 2.1 Letta (formerly MemGPT)

**Approach**: Virtual context management. The LLM itself manages its memory via tool calls.

- Agent has `core_memory` (always in context) + `archival_memory` (searchable storage) + `recall_memory` (conversation history)
- The LLM decides WHEN to save/retrieve by calling tools: `core_memory_append`, `core_memory_replace`, `archival_memory_insert`, `archival_memory_search`
- Core memory = small, always-present block (~2K tokens). Edited in-place by the agent.
- Archival = vector-indexed long-term storage
- Recall = paginated conversation history

**Key difference from mem0**: Memory management is **agentic** — the LLM decides what to remember via tool calls, rather than a separate extraction pipeline. More flexible but less predictable.

**Pros**: Agent has full control; can store arbitrary structured data.
**Cons**: Requires tool-use capable LLMs; agent must be trained/prompted to use memory tools; memory quality depends on agent behavior.

### 2.2 Zep

**Approach**: Background memory extraction (similar to mem0) + knowledge graph.

- Ingests conversation messages asynchronously
- Extracts "facts" and builds a knowledge graph
- Supports temporal awareness (facts have time context)
- Provides session summaries
- Commercial product with open-source components

**Key difference from mem0**: More emphasis on knowledge graph, temporal reasoning, and automatic summarization. Less DIY-friendly.

### 2.3 "memU"

**Does not exist** as a known framework. The user may have been thinking of:
- mem0 (pronounced "mem-zero")
- MemGPT (now Letta)
- Or a conceptual term

### 2.4 Comparison Matrix

| Feature | mem0 | Letta/MemGPT | Zep |
|---------|------|--------------|-----|
| Extraction | Automatic (LLM pipeline) | Agentic (LLM tool calls) | Automatic (background) |
| Storage | Vector + optional graph | Vector + in-context block | Vector + knowledge graph |
| Memory update | LLM reconciliation | Agent edits directly | Background processing |
| Simplicity | Medium (2 LLM calls) | Complex (agent loop) | Complex (service) |
| Self-hostable | Yes (fully) | Yes (server required) | Partial |
| Min deps | LLM + embeddings API | LLM API | LLM + service |
| Best for | Fact recall | Agentic workflows | Enterprise chatbots |

---

## 3. Key Design Patterns

### 3.1 The "Extract-then-Reconcile" Pattern (mem0)

This is the **most important pattern** for agent memory:

```
[conversation] → LLM("extract facts") → [new facts]
[new facts] → search(similar existing) → [old facts]  
[new + old facts] → LLM("ADD/UPDATE/DELETE") → [actions]
```

**Why it works**: Atomic facts are easy to compare, update, and retrieve. The reconciliation step prevents memory bloat and contradictions.

### 3.2 The "Agentic Memory" Pattern (Letta)

The agent itself decides what to remember:
```
Agent has tools: memory_save(key, value), memory_search(query), memory_delete(key)
System prompt: "You have a persistent memory. Use memory_save to remember important facts."
```

**Simpler to implement** but quality depends entirely on the agent's judgment.

### 3.3 The "Append-and-Summarize" Pattern (clawd's current approach)

What clawd already does:
```
Store all messages in SQLite → FTS5 search → Session compaction via summarization
```

This is a valid approach for **conversation memory** but misses **fact extraction** (turning messy conversations into structured knowledge).

### 3.4 Retrieval Without Vector Search

Alternatives that work without embeddings API:

1. **SQLite FTS5** (already in clawd) — full-text search with BM25 ranking
2. **Keyword extraction + exact match** — LLM extracts keywords, stored as tags
3. **Recency + importance scoring** — newer memories ranked higher; LLM assigns importance score
4. **Category-based** — memories organized by topic/category; retrieve entire category
5. **TF-IDF in-process** — compute TF-IDF locally (no API needed, decent quality)

**Recommendation**: FTS5 is the sweet spot. Already in SQLite, no external deps, good enough for memory retrieval.

### 3.5 Memory Scoping for Multi-Agent/Multi-Channel Systems

```
memories/
├── global/          # Shared across all agents/channels
│   └── facts.json   # Project-level facts
├── agent/{agentId}/ # Per-agent personality/knowledge
│   └── facts.json
├── channel/{channelId}/ # Per-channel context
│   └── facts.json
└── user/{userId}/   # Per-user preferences
    └── facts.json
```

Or in SQLite:
```sql
CREATE TABLE memories (
    id TEXT PRIMARY KEY,
    content TEXT NOT NULL,
    category TEXT,           -- 'preference', 'fact', 'plan', 'technical'
    scope_type TEXT,         -- 'global', 'agent', 'channel', 'user'  
    scope_id TEXT,           -- the specific agent/channel/user ID
    importance REAL DEFAULT 0.5,
    created_at INTEGER,
    updated_at INTEGER,
    access_count INTEGER DEFAULT 0,
    source_session TEXT      -- which conversation created this
);
CREATE INDEX idx_scope ON memories(scope_type, scope_id);
CREATE VIRTUAL TABLE memories_fts USING fts5(content, category);
```

### 3.6 Memory Conflict Resolution

mem0's approach (and the best one):
- **Same fact, updated value**: UPDATE (LLM decides)
- **Contradictory facts**: DELETE old + ADD new (LLM decides)
- **Redundant facts**: NONE (skip, LLM recognizes duplicates)
- **Content hash**: MD5 hash prevents exact duplicates at storage level

**For a no-vector approach**: Use FTS5 to find similar existing memories, then pass both old and new to LLM for reconciliation. Same pattern, just swap vector search for text search.

---

## 4. Simple Implementation (No External Deps)

### 4.1 Minimal Architecture

```
┌──────────────────────────────────────────┐
│              Agent Conversation            │
└──────────────┬───────────────────────────┘
               │
               ▼
┌──────────────────────────────────────────┐
│  Fact Extraction (LLM call, end of turn) │
│  "Extract key facts from this exchange"  │
└──────────────┬───────────────────────────┘
               │
               ▼
┌──────────────────────────────────────────┐
│  SQLite FTS5 Search                      │
│  Find similar existing memories          │
└──────────────┬───────────────────────────┘
               │
               ▼
┌──────────────────────────────────────────┐
│  Memory Reconciliation (LLM call)        │
│  ADD / UPDATE / DELETE / NONE            │
└──────────────┬───────────────────────────┘
               │
               ▼
┌──────────────────────────────────────────┐
│  SQLite Storage                          │
│  memories table + FTS5 index             │
└──────────────────────────────────────────┘
```

### 4.2 Extraction Prompt (Simplified from mem0)

```
You extract key facts from conversations. Return JSON only.

Categories: preferences, personal details, plans, technical decisions, project context.

Examples:
Input: "I prefer TypeScript over JavaScript for new projects"
Output: {"facts": ["Prefers TypeScript over JavaScript for new projects"]}

Input: "We decided to use SQLite for the database"  
Output: {"facts": ["Project uses SQLite for database"]}

Input: "Hello, how are you?"
Output: {"facts": []}

Rules:
- Only extract from user messages
- Each fact must be self-contained (understandable without context)
- Skip greetings, meta-conversation, questions
- Return {"facts": []} if nothing worth remembering
```

### 4.3 Reconciliation Prompt (Simplified from mem0)

```
You manage a memory store. Given existing memories and new facts, decide for each:
- ADD: New information not in memory
- UPDATE: Existing memory needs updating (return both old and new)
- DELETE: Information contradicted by new facts
- NONE: Already known, no change needed

Existing memories:
{existing_memories}

New facts:
{new_facts}

Return JSON:
{"actions": [
  {"event": "ADD|UPDATE|DELETE|NONE", "id": "existing_id_or_null", "text": "memory content", "old_text": "if UPDATE"}
]}
```

### 4.4 Retrieval (FTS5-Based)

```typescript
// At start of conversation turn:
function getRelevantMemories(query: string, scopeType: string, scopeId: string, limit = 10): Memory[] {
    // 1. FTS5 search
    const ftsResults = db.query(`
        SELECT m.*, rank 
        FROM memories m
        JOIN memories_fts ON m.rowid = memories_fts.rowid
        WHERE memories_fts MATCH ?
        AND m.scope_type = ? AND m.scope_id = ?
        ORDER BY rank
        LIMIT ?
    `).all(ftsQuery(query), scopeType, scopeId, limit);
    
    // 2. Also get recent memories (recency bias)
    const recentResults = db.query(`
        SELECT * FROM memories
        WHERE scope_type = ? AND scope_id = ?
        ORDER BY updated_at DESC
        LIMIT 5
    `).all(scopeType, scopeId);
    
    // 3. Merge and deduplicate
    return mergeAndDedup(ftsResults, recentResults);
}
```

### 4.5 Memory Decay / Bounding

```sql
-- Delete memories not accessed in 90 days with low importance
DELETE FROM memories 
WHERE access_count = 0 
AND updated_at < unixepoch() - 7776000 
AND importance < 0.3;

-- Or: limit per scope (keep top N by importance + recency)
DELETE FROM memories WHERE id NOT IN (
    SELECT id FROM memories 
    WHERE scope_type = ? AND scope_id = ?
    ORDER BY importance DESC, updated_at DESC
    LIMIT 500
);
```

---

## 5. Recommendations

### For clawd specifically:

1. **Adopt the Extract-then-Reconcile pattern** — it's proven, simple, and effective. Two LLM calls per conversation turn.

2. **Use SQLite FTS5 for retrieval** — clawd already has FTS5 infrastructure in `memory.ts` and `knowledge-base.ts`. No need for vector search or embeddings API.

3. **Add a `memories` table** alongside existing `messages` table — store extracted facts separately from raw conversation history.

4. **Scope memories as**: `global` (project), `agent` (per-agent), `channel` (per-channel/conversation), `user` (per-user). Filter at query time.

5. **Run extraction at conversation end** (or periodically) — not on every message. Batch is more token-efficient.

6. **Skip graph memory** — YAGNI. The vector/FTS approach handles 95% of use cases. Graph adds Neo4j complexity for marginal benefit.

7. **Skip embeddings API** — FTS5 + recency scoring is sufficient for memory retrieval in a coding agent context. Saves cost and external dependency.

### Cost of mem0's approach:
- 2 LLM calls per `add()` operation (extraction + reconciliation)
- 1 embedding call per extracted fact (for vector search)
- 1 embedding call per search query
- For clawd: can eliminate embedding calls entirely by using FTS5

### What NOT to do:
- Don't store entire conversations as "memories" — extract atomic facts
- Don't use vector search if you don't already have an embeddings pipeline
- Don't implement graph memory unless you have entity-heavy use cases
- Don't build a memory system that requires external services (Qdrant, Neo4j, etc.)

---

## Unresolved Questions

1. **Extraction frequency**: Should facts be extracted after every user message, every assistant response, or only at session end? mem0 does it on-demand per `add()` call — the caller decides when.

2. **FTS5 vs vector search quality**: How much retrieval quality do we lose by using FTS5 instead of embeddings? For coding agent context (technical terms, project names), FTS5 may actually be *better* than semantic search since it's exact-match oriented.

3. **Token cost**: The reconciliation LLM call includes all existing similar memories. With 100+ memories, this could get expensive. May need to limit to top-10 similar memories.

4. **Procedural memory**: mem0's procedural memory (full conversation summarization) could be valuable for long-running agent tasks. Worth considering as a separate feature.

5. **Cross-scope memory**: Should a memory created in `channel/123` be visible in `channel/456` if it's about the same project? Need to define inheritance/fallback rules.
