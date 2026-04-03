# Memory System

Claw'd features a multi-layered memory architecture spanning three distinct stores, each serving different purposes. The system operates through four automatic phases: extraction, compaction harvest, consolidation, and reflection.

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                     MEMORY SYSTEM LAYERS                         │
├─────────────────────────────────────────────────────────────────┤
│  Layer 1: MemoryManager (session-level)                           │
│  ├── Stores: chat messages via FTS5 (messages_fts)              │
│  ├── Tools: chat_search, memory_summary                  │
│  └── Purpose: Search past conversations, session summaries        │
├─────────────────────────────────────────────────────────────────┤
│  Layer 2: KnowledgeBase (tool output indexing)                   │
│  ├── Stores: Indexed tool outputs, chunked by headings/lines     │
│  ├── Tools: knowledge_search                                     │
│  └── Purpose: Retrieve truncated or past tool outputs            │
├─────────────────────────────────────────────────────────────────┤
│  Layer 3: AgentMemoryStore (per-agent long-term memory)          │
│  ├── Stores: Structured memories (facts, preferences, etc.)     │
│  ├── Tools: memo_save, memo_recall, memo_delete, memo_pin       │
│  └── Purpose: Persistent per-agent/per-channel memory            │
└─────────────────────────────────────────────────────────────────┘
```

All three stores share the same SQLite database at `~/.clawd/data/memory.db` (migrated from legacy `~/.clawd/memory.db`).

---

## 1. MemoryManager — Session Chat History

**File:** `src/agent/memory/memory.ts`

Manages conversation history with full-text search capabilities. Stores all messages from all sessions with FTS5 indexing for keyword search.

### Key Methods

- `search(query)` — FTS5 search across all messages with time/role filters
- `searchByKeywords(keywords, limit)` — Convenience wrapper for keyword searches
- `searchByTimeRange(startTime, endTime, limit)` — Time-bounded searches
- `getRecentContext(sessionId, maxTokens)` — Token-budgeted context retrieval
- `getSessionSummary(sessionId)` — Generates session statistics and key topics
- `compactSession(sessionId, maxMessages, summarizer)` — Summarizes old messages

### Token Estimation

MemoryManager includes sophisticated token estimation for context budgeting:

- Base64 content detection (3.5 chars/token ratio)
- Code-heavy content detection (2.8 chars/token)
- Prose content detection (4.0 chars/token)
- FNV-1a content hashing for cache keying

---

## 2. KnowledgeBase — Tool Output Indexing

**File:** `src/agent/memory/knowledge-base.ts`

Indexes large tool outputs for retrieval via BM25 FTS5 search. Automatically chunks content by markdown headings or line counts.

### Key Features

- **BM25 FTS5 search** with substring fallback
- **Channel-scoped search** — all agents in a channel share knowledge
- **Automatic chunking** — splits content by headings (markdown) or line counts (20 lines per chunk, 5-line overlap)
- **Base64 stripping** — removes encoded content before indexing
- **Session size limits** — 100MB per session, 2GB global
- **LRU eviction** — oldest entries evicted when limits approached

### Chunking Strategy

```
Content < 500 chars     →  Single chunk
Markdown with headings  →  Chunk by heading boundaries
Other content           →  Chunk by 20-line blocks with overlap
```

### Search Methods

- `search(query, sessionId?, limit)` — BM25 FTS5 search with substring fallback
- `searchByChannel(query, channel, limit)` — Channel-scoped knowledge sharing
- `invalidateSource(sessionId, sourceId)` — Refresh specific file indexing
- `invalidateSession(sessionId)` — Clear session indexing

---

## 3. AgentMemoryStore — Long-Term Per-Agent Memory

**File:** `src/agent/memory/agent-memory.ts`

Persistent memory system for individual agents with automatic extraction, consolidation, and reflection.

### Memory Categories

| Category    | Purpose                              | Default Priority |
|-------------|--------------------------------------|------------------|
| `fact`      | Objective facts about the project     | 50               |
| `preference`| User preferences and习惯             | 50               |
| `decision`  | Design decisions and choices made    | 50               |
| `lesson`    | Learned insights and discoveries      | 50               |
| `correction`| Bug fixes and corrections            | 50               |

### Limits & Caps

- **Max memories per agent:** 2,000
- **Max pinned memories:** 25 (priority >= 80)
- **Auto-extracted priority:** 40
- **Explicit save priority:** 50
- **Unpinned priority range:** 0-79
- **Pinned priority:** 80-100

### Key Methods

- `save(input)` — Save with automatic dedup (Jaccard similarity >= 0.5)
- `recall(opts)` — FTS5 search or recent retrieval
- `getRelevant(agentId, channel, keywords, maxRecent, maxRelevant)` — Relevance-scored retrieval
- `findSimilar()` — Jaccard-based duplicate detection
- `pin(id, agentId)` / `unpin(id, agentId)` — Pin management
- `decayPriorities()` — Periodic decay for old unaccessed memories
- `findConsolidationCandidates()` — Groups for LLM merging
- `mergeMemories()` — LLM-powered memory consolidation
- `getMemoryHints()` — Topic summary for agent awareness
- `updateEffectiveness()` — Reflection-driven priority adjustment

### Scoped Storage

Memories support two scopes:
- **Channel-scoped** (default) — Only visible in the current channel
- **Agent-wide** (`scope: "agent"`) — Shared across all channels for the agent

---

## 4. Memory Plugin — Auto-Extraction & Injection

**File:** `src/agent/plugins/memory-plugin.ts`

The plugin orchestrates four automatic phases triggered by agent lifecycle events.

### Auto-Extraction (onAgentResponse)

Extracts key facts from agent responses using LLM analysis.

**Heuristic Gating:**
- Skips responses < 100 characters
- Skips first 2 turns (greetings/setup)
- Skips responses without significant patterns (decisions, preferences, code, etc.)
- Blocks extraction of responses containing secrets (API keys, tokens)

**Significant Patterns:**
```
/\b(decided|prefer|always|never|remember|important|note|learned|key|must|should)\b/i
/\b(bug|fix|error|issue|solution|pattern|approach|architecture|config)\b/i
/\b(user wants|user prefers|requirement|constraint|deadline)\b/i
/\b(endpoint|url|port|host)\b/i
/```[\s\S]{20,}```/
```

**Secret Blocklist:**
```
/\b(password|token|secret|api[_-]?key)\s*[:=]\s*\S+/i
/\b(sk-|ghp_|gho_|xoxb-|xoxp-|AKIA)\S{10,}/i
```

### Compaction Harvest (beforeCompaction)

Before context compaction drops messages, critical information is extracted:

- Max 8 items at priority 40-70
- Focus on: decisions, preferences, rules, corrections, bugs, architecture
- Cap at 8K chars of dropped messages for cost control
- Skips tool results (often verbose, low signal)

### Consolidation (every 25-50 turns)

When memory count >= 1,600 or every 200 turns:

1. Find consolidation candidates by category
2. Cluster similar memories (Jaccard >= 0.3)
3. LLM merges each cluster into a single memory
4. Max 3 categories, 3 clusters per run
5. Preserves highest priority, max effectiveness, total access count

### Reflection (every 100 turns)

Evaluates recently injected memories for effectiveness:

1. Track injected memory IDs per context load
2. LLM rates each memory: critical / useful / neutral / irrelevant
3. Update effectiveness scores:
   - **critical:** delta +0.1, priority +5
   - **useful:** delta +0.05, priority +2
   - **irrelevant:** delta -0.1, priority -5

### Memory Injection (getSystemContext)

Injects memories into system prompt with 4,000 char cap:

```
<agent_memory>
  <session_dna compactions="N" turn="N">
    (orientation context after compactions)
  </session_dna>
  
  <pinned_rules>
    (pinned memories, up to 1,500 chars)
  </pinned_rules>
  
  <relevant>
    (recent + keyword-relevant memories)
  </relevant>
  
  <memory_topics>
    (category summaries: fact (12): api, endpoint, auth...)
  </memory_topics>
</agent_memory>
```

### Injection Tiers

1. **Pinned** (priority >= 80) — Always loaded, up to 25
2. **FTS5 Relevant** — Weighted scoring:
   - FTS rank: 35%
   - Priority: 25%
   - Recency: 15%
   - Effectiveness: 15%
   - Access count: 10%
3. **Tag-matched** — Fallback for additional relevant memories
4. **Recent** — 5 most recent non-pinned memories

### Synonym Expansion

Query expansion uses a static synonym map for better recall:

```typescript
{
  login: ["authentication", "auth", "signin", "sign-in"],
  auth: ["authentication", "login", "signin", "authorization"],
  bug: ["error", "issue", "defect", "problem"],
  api: ["endpoint", "route", "rest", "graphql"],
  // ... 25+ domain mappings
}
```

---

## 5. CC Main Agent Integration

**File:** `src/claude-code-main-worker.ts`

The main Claude Code agent integrates memory via `loadMemoryContext()`:

```typescript
private loadMemoryContext(): string {
  const memories = this.memoryStore.getRelevant(
    agentId, channel, this.lastKeywords, 5, 10
  );
  if (memories.length === 0) return "";
  
  // Render to <relevant> tags, same format as plugin injection
  return formatMemories(memories);
}
```

This uses the same `AgentMemoryStore.getRelevant()` method, ensuring consistency with sub-agents.

---

## Tool Reference

### chat_search

Search past conversation history with full-text search.

| Parameter   | Type     | Description                          |
|-------------|----------|--------------------------------------|
| `keywords`  | string[] | Keywords for FTS5 search             |
| `start_time`| number   | Unix timestamp (ms) to search from   |
| `end_time`  | number   | Unix timestamp (ms) to search until  |
| `role`      | string   | Filter: user, assistant, tool         |
| `session_id`| string   | Limit to specific session            |
| `limit`     | number   | Max results (default: 20)             |

### memory_summary

Get a session summary with message count, time range, and key topics.

| Parameter   | Type   | Description        |
|-------------|--------|--------------------|
| `session_id`| string | Session to summarize |

### knowledge_search

Search indexed tool outputs from the current channel.

| Parameter | Type   | Description                       |
|-----------|--------|-----------------------------------|
| `query`   | string | Search query                      |
| `scope`   | string | "channel" (default) or "session"  |
| `limit`   | number | Max results (default: 10)          |

### memo_save

Save information to long-term memory.

| Parameter  | Type   | Description                                      |
|------------|--------|--------------------------------------------------|
| `content`  | string | Information to remember (50-5000 chars)          |
| `category` | string | fact, preference, decision, lesson, correction   |
| `scope`    | string | "channel" (default) or "agent"                   |

### memo_recall

Search long-term memories.

| Parameter  | Type   | Description                    |
|------------|--------|--------------------------------|
| `query`    | string | Search keywords                |
| `category` | string | Filter by category             |
| `limit`    | number | Max results (default: 20)      |
| `offset`   | number | Pagination offset              |

### memo_delete

Delete a memory by ID.

| Parameter | Type   | Description      |
|-----------|--------|------------------|
| `id`      | number | Memory ID to delete |

### memo_pin / memo_unpin

Pin a memory for always-on injection (max 25).

| Parameter | Type   | Description   |
|-----------|--------|---------------|
| `id`      | number | Memory ID     |

### identity_update

Update the agent's identity/role file for behavioral guidance.

| Parameter | Type   | Description                        |
|-----------|--------|------------------------------------|
| `content` | string | Identity content (50-10,000 chars) |

---

## Database Schema

### agent_memories

```sql
CREATE TABLE agent_memories (
  id INTEGER PRIMARY KEY,
  agent_id TEXT NOT NULL,
  channel TEXT,
  category TEXT NOT NULL,
  content TEXT NOT NULL,
  source TEXT NOT NULL,
  priority INTEGER DEFAULT 50,
  tags TEXT,
  effectiveness REAL DEFAULT 0.5,
  access_count INTEGER DEFAULT 0,
  last_accessed INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE VIRTUAL TABLE agent_memories_fts USING fts5(
  content, content='agent_memories', content_rowid='id'
);
```

### knowledge

```sql
CREATE TABLE knowledge (
  id INTEGER PRIMARY KEY,
  session_id TEXT NOT NULL,
  source_id TEXT NOT NULL,
  tool_name TEXT NOT NULL,
  chunk_index INTEGER NOT NULL,
  content TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE VIRTUAL TABLE knowledge_fts USING fts5(
  content, content='knowledge', content_rowid='id'
);
```

### messages (via FTS5 triggers)

Managed by MemoryManager with FTS5 triggers keeping `messages_fts` in sync.

---

## Configuration

Memory plugin is configured via `memory` in agent config:

```typescript
// Enable with defaults
memory: true

// Enable with custom settings
memory: {
  provider: "openai",  // Optional LLM provider
  model: "gpt-4o-mini", // Optional model
  autoExtract: true     // Default: true
}
```

The plugin can be disabled entirely by setting `autoExtract: false`, which still allows explicit `memo_*` tools but skips automatic extraction.

---

## Usage Examples

### Automatic Memory

The system automatically extracts and remembers:

```
User: "Remember that the API is at localhost:3001"
Assistant: "Got it! The API runs on port 3001."
→ Auto-extracted as: fact "API is at localhost:3001"
```

### Explicit Memory

```json
memo_save({
  "content": "User prefers TypeScript over JavaScript",
  "category": "preference"
})
```

### Memory Search

```json
memo_recall({
  "query": "API endpoint",
  "category": "fact"
})
```

### Knowledge Retrieval

When tool output is truncated:

```
[Indexed] Tool output truncated. Use knowledge_search("error handling").
```

```json
knowledge_search({
  "query": "error handling",
  "scope": "channel"
})
```
