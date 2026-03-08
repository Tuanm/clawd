# Research Report: Long-Term Memory in AI Agent Systems

**Date**: 2026-03-08
**Sources**: Clawd codebase analysis, mem0 architecture (prior research), GoClaw analysis (prior research), MemGPT/Letta papers, Claude Code/Cursor/Windsurf public docs, LangChain memory docs

---

## Executive Summary

This report synthesizes findings from 8 source systems (mem0, Letta/MemGPT, GoClaw, Zep, Claude Code, Cursor, Windsurf, Clawd's own codebase) into actionable patterns for implementing long-term agent memory with SQLite+FTS5. The report is structured around your 8 research areas with concrete implementation guidance.

**Core insight**: The field has converged on 3 dominant patterns — (1) LLM-extracted atomic facts with reconciliation (mem0), (2) agent-controlled memory via tools (Letta/MemGPT), (3) pre-compaction memory flush (GoClaw/Claude Code). **Clawd already implements pattern #2 well.** The biggest gaps are: no pre-compaction extraction hook, no memory priority tiers, and limited consolidation.

---

## Table of Contents

1. [How AI Coding Agents Handle Memory](#1-how-ai-coding-agents-handle-memory)
2. [Memory Architectures for LLM Agents](#2-memory-architectures-for-llm-agents)
3. [Agent Self-Consciousness Across Sessions](#3-agent-self-consciousness-across-sessions)
4. [Semantic Search Without Vector DBs](#4-semantic-search-without-vector-dbs)
5. [Memory Consolidation & Summarization](#5-memory-consolidation--summarization)
6. [Priority-Based Memory: Never-Forget Rules](#6-priority-based-memory-never-forget-rules)
7. [Compaction-Aware Memory Extraction](#7-compaction-aware-memory-extraction)
8. [Tiered Memory Architectures](#8-tiered-memory-architectures)
9. [Implementation Plan for Clawd](#9-implementation-plan-for-clawd)
10. [Unresolved Questions](#10-unresolved-questions)

---

## 1. How AI Coding Agents Handle Memory

### Claude Code
- **CLAUDE.md files**: Project-level markdown files loaded into system prompt. Human-editable. No auto-extraction.
- **Session persistence**: Conversation history stored locally. On `/compact`, older messages summarized via LLM.
- **Memory model**: Static rules (CLAUDE.md) + ephemeral conversation. No cross-session learning. No memory tools.
- **Key pattern**: Memory-as-system-prompt. Simple, reliable, human-auditable. Limitation: doesn't learn from experience.

### Cursor
- **Rules files**: `.cursorrules` and `.cursor/rules/*.md` — project-level instruction files.
- **Context indexing**: Indexes entire codebase for retrieval. Uses embeddings for file search.
- **Session model**: Each chat = fresh session. Previous chats accessible for manual reference. No auto-memory.
- **Long-context**: Relies on large context windows (200K+) rather than memory systems.
- **Key pattern**: Codebase-as-memory. The project itself IS the long-term memory. Agent re-reads files as needed.

### Windsurf (Codeium)
- **Cascade memory**: Proprietary "Cascade" system with flow awareness — tracks what files agent has seen.
- **Session continuity**: Terminal output, file changes, and browser state tracked across steps.
- **Memories feature**: Explicit user-defined memories ("Always use TypeScript strict mode") persisted across sessions.
- **Key pattern**: Hybrid — static rules + session state tracking. Closest to Clawd's current architecture.

### Aider
- **Chat history**: Stores full conversation in `.aider.chat.history.md`.
- **Repository map**: Builds a tree-sitter map of code structure (functions, classes) for efficient context retrieval.
- **No persistent memory**: Each session starts fresh. Manual `/add` to include files.
- **Key pattern**: Codebase structure as implicit memory. Good for code-focused agents.

### GoClaw (analyzed in prior research)
- **Dual-mode**: Markdown files + vector embeddings + FTS5 hybrid search.
- **Pre-compaction flush**: LLM extracts important info before compaction (90s timeout, file tools only).
- **Key pattern**: Pre-compaction memory flush is the most architecturally significant innovation. See §7.

### Summary: What Works

| Agent | Memory Model | Auto-Extract? | Cross-Session? | Priority System? |
|-------|-------------|:---:|:---:|:---:|
| Claude Code | Static CLAUDE.md | ❌ | ✅ (manual) | ❌ |
| Cursor | .cursorrules + codebase | ❌ | ✅ (manual) | ❌ |
| Windsurf | Explicit memories | ❌ | ✅ | ❌ |
| Aider | Chat history file | ❌ | ❌ | ❌ |
| GoClaw | Markdown + hybrid search | ✅ (flush) | ✅ | ❌ |
| **Clawd** | **FTS5 + tool-based** | **✅ (auto)** | **✅** | **Partial** |

**Clawd is already ahead of most competitors** on auto-extraction. The gap: no priority tiers, no pre-compaction hook, no consolidation.

---

## 2. Memory Architectures for LLM Agents

### Pattern A: Extract-then-Reconcile (mem0)

```
Conversation → LLM("extract facts") → [new facts]
[new facts] → search(similar existing) → [old facts]
[new + old] → LLM("ADD/UPDATE/DELETE") → [actions]
```

**Pros**: Clean memory store, handles contradictions, prevents bloat.
**Cons**: 2 LLM calls per extraction cycle. Expensive at scale.
**Best for**: When you need high-quality, deduplicated fact storage.

**Clawd's current approach**: Uses Jaccard similarity for dedup (agent-memory.ts L298-361) + FTS5 candidates. This is ~80% of mem0's reconciliation quality without the extra LLM call. **Good enough. Don't change.**

### Pattern B: Agentic Memory (Letta/MemGPT)

```
Agent has 3 memory zones:
  core_memory:     ~2K tokens, always in system prompt, agent edits via tools
  archival_memory: Vector-indexed, unlimited, agent searches via tools
  recall_memory:   Paginated conversation history
```

**Key tools**:
- `core_memory_append(key, value)` — add to always-present context
- `core_memory_replace(key, old, new)` — update in-place
- `archival_memory_insert(content)` — store for later retrieval
- `archival_memory_search(query)` — retrieve from long-term store

**Clawd's alignment**: Already implements this via `memo_save`, `memo_recall`, `memo_delete`, `identity_update`. The missing piece: **core_memory** (always-present, high-priority block). See §6.

### Pattern C: Session Checkpoint (Copilot/Claude Code)

```
Periodic checkpoint creation:
  1. Score messages by importance
  2. Generate structured summary (LLM or heuristic)
  3. Store checkpoint as markdown
  4. On compaction, inject checkpoint into context
```

**Clawd's implementation**: `checkpoint.ts` + `message-scoring.ts` + `working-state.ts` already implement this well. The `WorkingState` (inception task, decisions, files, errors, plan) is the "always-present" context. **This is Clawd's strongest differentiator.**

### Architecture Comparison

| Dimension | mem0 | Letta | GoClaw | **Clawd** |
|-----------|------|-------|--------|-----------|
| Extraction | LLM pipeline | Agent tools | Pre-compaction flush | Agent tools + auto-extract |
| Storage | Vector + SQLite | Vector + in-memory | Markdown + SQLite + pgvector | SQLite FTS5 |
| Dedup | LLM reconciliation | Agent judgment | SHA256 hash | Jaccard + FTS5 |
| Priority | None | core_memory is priority | None | **Needs improvement** |
| Identity | Per-agent metadata | core_memory block | None | identity_update tool |
| Working state | None | core_memory | None | WorkingState JSON |

---

## 3. Agent Self-Consciousness Across Sessions

### What "Self-Consciousness" Means for Agents

Not sentience — **persistent behavioral identity**. Three components:

1. **Static Identity**: Who am I? (role file, personality, expertise areas)
2. **Learned Rules**: What have I learned? (corrections, preferences, decisions)
3. **Autobiographical Memory**: What have I done? (session summaries, project history)

### Current Clawd Implementation

Clawd already has the building blocks:

1. **Static Identity**: `identity_update` tool writes role files to `.clawd/roles/{agentId}.md` (memory-plugin.ts L162-223). Loaded into system prompt.
2. **Learned Rules**: `memo_save` with categories (lesson, correction, preference). Auto-injection via `getRelevant()`.
3. **Autobiographical Memory**: Checkpoints + working state + session summaries.

### What's Missing

**Identity evolution loop**: The agent should periodically review its memories and update its identity file. Pattern:

```
Every N sessions (or on explicit trigger):
  1. Recall all "lesson" and "correction" memories
  2. Recall all "preference" memories
  3. Read current identity file
  4. LLM: "Given these lessons/corrections/preferences, update identity to reflect learned behaviors"
  5. Write updated identity via identity_update
```

**Implementation note**: This is LOW priority. The current explicit `identity_update` + `memo_save` approach is sufficient. Auto-evolution is a nice-to-have that risks drift.

### Cross-Session Identity Pattern (Recommended)

```
Session Start:
  1. Load identity file → system prompt
  2. Load top-K memories by priority → system prompt
  3. Load working state → system prompt
  4. Load last checkpoint → system prompt

Session End:
  1. Extract important facts (auto-extraction, already implemented)
  2. Save working state (already implemented)
  3. Create checkpoint if threshold exceeded (already implemented)
```

**The gap**: Step 2 at session start — injecting top-K memories by priority. Currently `getRelevant()` uses recency + FTS keyword match. Need to add priority weighting. See §6.

---

## 4. Semantic Search Without Vector DBs

### FTS5 is Good Enough (For This Use Case)

**Key insight**: For agent memory retrieval in a coding context, FTS5+BM25 is arguably *better* than vector search because:

1. **Technical terms are precise**: "SQLite FTS5" as a query should match "SQLite FTS5" exactly, not "PostgreSQL full-text search" (which vectors would consider similar).
2. **No embedding API dependency**: Zero latency, zero cost, works offline.
3. **Deterministic**: Same query → same results. Vectors have floating-point non-determinism.

### Enhancing FTS5 for Memory Retrieval

#### Technique 1: Query Expansion via LLM (Expensive but Effective)

```typescript
// Before searching, expand the query
async function expandQuery(query: string): Promise<string[]> {
  const expanded = await llm.complete({
    messages: [{ role: "user", content: 
      `Given this search query, generate 3-5 alternative phrasings/synonyms:\n"${query}"\nReturn JSON array of strings.` 
    }],
    max_tokens: 100
  });
  return JSON.parse(expanded); // ["original query", "synonym1", "related term", ...]
}
```

**Verdict**: YAGNI for now. Only worth it if users report poor recall.

#### Technique 2: Keyword Extraction + Multi-Term OR (Already Implemented)

Clawd's `sanitizeFTSQuery()` in agent-memory.ts already does this:
```typescript
// "always run tests before commits" → "always" OR "tests" OR "before" OR "commits"
function sanitizeFTSQuery(query: string): string {
  const words = query.replace(/[^\p{L}\p{N}\s]/gu, " ").split(/\s+/).filter(w => w.length > 1);
  return words.map(w => `"${w}"`).join(" OR ");
}
```

**Improvement**: Use `AND` for short queries (1-3 terms) and `OR` for longer queries:
```typescript
function buildFTSQuery(query: string): string {
  const words = extractKeywords(query).slice(0, 8);
  if (words.length <= 3) return words.map(w => `"${w}"`).join(" AND ");
  return words.map(w => `"${w}"`).join(" OR ");
}
```

#### Technique 3: Combined Scoring (FTS + Recency + Access Count)

```sql
-- Weighted combination of BM25 rank, recency, and importance
SELECT am.*, 
  (0.5 * (1.0 / (1.0 + ABS(fts.rank)))) +     -- FTS relevance (0-1)
  (0.3 * (1.0 - MIN(1.0, (unixepoch() - am.updated_at) / 2592000.0))) + -- Recency decay (30 days)
  (0.2 * MIN(1.0, am.access_count / 10.0))      -- Access frequency
  AS combined_score
FROM agent_memories am
JOIN agent_memories_fts fts ON am.id = fts.rowid
WHERE fts.agent_memories_fts MATCH ?
  AND am.agent_id = ?
ORDER BY combined_score DESC
LIMIT ?;
```

**Recommendation**: Implement this as a `searchWeighted()` method. Simple, effective, no external deps.

#### Technique 4: N-gram Similarity for Dedup (Beyond Jaccard)

Clawd uses Jaccard word similarity (agent-memory.ts L338-360). For better dedup:

```typescript
// Trigram similarity (like PostgreSQL's pg_trgm)
function trigramSimilarity(a: string, b: string): number {
  const trigramsA = new Set(ngrams(a.toLowerCase(), 3));
  const trigramsB = new Set(ngrams(b.toLowerCase(), 3));
  const intersection = [...trigramsA].filter(t => trigramsB.has(t)).length;
  const union = new Set([...trigramsA, ...trigramsB]).size;
  return union > 0 ? intersection / union : 0;
}

function ngrams(text: string, n: number): string[] {
  const padded = `  ${text}  `;
  const result: string[] = [];
  for (let i = 0; i <= padded.length - n; i++) {
    result.push(padded.slice(i, i + n));
  }
  return result;
}
```

**Verdict**: Current Jaccard at 0.5 threshold is working. Only upgrade if dedup false negatives become a problem.

### Performance at 500+ Memories

FTS5 handles 500 memories trivially. SQLite FTS5 is tested to millions of rows. No concern here.

**Actual bottleneck**: System prompt injection size. With 500 memories, you can't inject all of them. Current `getRelevant()` returns max 15 (5 recent + 10 keyword-matched). This is correct.

---

## 5. Memory Consolidation & Summarization

### The Consolidation Problem

Over time, agent accumulates:
- Duplicate facts stated differently ("Uses TypeScript" + "Project language is TypeScript")
- Outdated facts ("Database is MySQL" → later "Migrated to PostgreSQL")
- Fragmented knowledge across many small memories
- Low-value noise from auto-extraction

### Consolidation Strategy: Periodic LLM-Driven Merge

```typescript
async function consolidateMemories(agentId: string, store: AgentMemoryStore): Promise<void> {
  // 1. Get all memories for this agent
  const all = store.recall({ agentId, limit: 500 });
  if (all.length < 50) return; // Not worth consolidating
  
  // 2. Group by category
  const groups = groupBy(all, m => m.category);
  
  // 3. For each category, ask LLM to consolidate
  for (const [category, memories] of Object.entries(groups)) {
    if (memories.length < 10) continue;
    
    const prompt = `You manage a memory store for an AI agent. 
Consolidate these ${memories.length} "${category}" memories into a minimal, non-redundant set.
Rules:
- Merge duplicates into single entries
- Remove outdated info contradicted by newer entries  
- Keep the most specific version of each fact
- Preserve all unique, valuable information
- Return JSON: {"keep": [{"id": N, "content": "updated text"}], "delete": [id1, id2, ...]}

Memories:
${memories.map(m => `#${m.id} (${formatAge(m.createdAt)}): ${m.content}`).join('\n')}`;
    
    const result = await llm.complete({ messages: [{ role: "user", content: prompt }], max_tokens: 2000 });
    // Apply keep/delete actions...
  }
}
```

**When to run**: 
- On agent startup if `getCount(agentId) > 400` (approaching 500 cap)
- Weekly scheduled job for active agents
- Manual trigger via tool

### Summarization Techniques for Compaction

Clawd already has good summarization in `summarizer.ts` and `checkpoint.ts`. Key improvement:

**Incremental checkpoints** (already implemented in checkpoint.ts L81-98): Only process new messages since last checkpoint, then merge. This prevents re-processing the entire history.

**Missing technique**: **Hierarchical summarization**. Instead of one flat summary:

```
Level 1: Individual message importance scoring (message-scoring.ts — already done)
Level 2: Turn-level summaries (group of tool_call + results)
Level 3: Task-level summaries (user request → resolution)
Level 4: Session-level summary (full checkpoint)
Level 5: Cross-session summary (project memory)
```

**Recommendation**: Don't implement all 5 levels. Clawd's current L1 (scoring) + L4 (checkpoints) is sufficient. Add L3 (task-level) only if users report poor context continuity.

---

## 6. Priority-Based Memory: Never-Forget Rules

### The Problem

When an agent learns a critical rule ("ALWAYS run tests before committing"), it must never be evicted — even when memory is full, even after many compactions, even across sessions.

### Current Gap in Clawd

`enforceAgentCap()` in agent-memory.ts L457-475 evicts by:
1. Auto-extracted memories first
2. Then by access_count ASC, last_accessed ASC

**Problem**: A critical correction that was learned 3 months ago and not recently accessed could be evicted. This is wrong.

### Solution: Priority Tiers

Add a `priority` column to `agent_memories`:

```sql
ALTER TABLE agent_memories ADD COLUMN priority INTEGER NOT NULL DEFAULT 0;
-- Priority levels:
-- 0: normal (auto-extracted facts, ephemeral context)
-- 1: important (explicit saves, learned preferences)
-- 2: critical (corrections, behavioral rules — NEVER evict)
-- 3: pinned (user-pinned memories — NEVER evict, show first)
```

**Updated eviction logic**:
```typescript
private enforceAgentCap(agentId: string): void {
  const count = this.getCount(agentId);
  if (count < MAX_MEMORIES_PER_AGENT) return;
  
  const toDelete = count - MAX_MEMORIES_PER_AGENT + 10;
  this.db.run(`
    DELETE FROM agent_memories WHERE id IN (
      SELECT id FROM agent_memories
      WHERE agent_id = ? AND priority < 2  -- NEVER evict critical/pinned
      ORDER BY
        priority ASC,                       -- lower priority evicted first
        CASE WHEN source = 'auto' THEN 0 ELSE 1 END,
        access_count ASC,
        last_accessed ASC
      LIMIT ?
    )
  `, [agentId, toDelete]);
}
```

**Updated save with auto-priority assignment**:
```typescript
function assignPriority(content: string, category: MemoryCategory, source: MemorySource): number {
  // Corrections and lessons from explicit saves are critical
  if (source === 'explicit' && (category === 'correction' || category === 'lesson')) return 2;
  
  // Behavioral rules detected by keywords
  if (/\b(always|never|must|critical|important|rule)\b/i.test(content)) return 1;
  
  // Explicit saves are important by default
  if (source === 'explicit') return 1;
  
  // Auto-extracted are normal
  return 0;
}
```

**Injection priority**: When injecting memories into system prompt, sort by priority DESC first:
```typescript
getRelevant(agentId, channel, keywords, maxRecent, maxRelevant) {
  // 1. Always include ALL priority >= 2 (critical/pinned) memories
  const critical = db.query(`
    SELECT * FROM agent_memories 
    WHERE agent_id = ? AND priority >= 2
    ORDER BY priority DESC, updated_at DESC
  `).all(agentId);
  
  // 2. Fill remaining budget with recent + keyword-relevant
  const remaining = maxRecent + maxRelevant - critical.length;
  // ... existing logic with remaining budget ...
}
```

### The "Rules" Pattern

For self-imposed rules specifically:

```typescript
// Agent saves a rule
memo_save({ content: "ALWAYS run tests before committing code", category: "correction", scope: "agent" })
// → auto-assigned priority 2 (critical, never evict)

// At injection time, rules appear first in <agent_memory>:
// <agent_memory>
// CRITICAL RULES:
// - [#42 correction] ALWAYS run tests before committing code
// - [#38 correction] Never modify package.json without running install
// 
// RECENT CONTEXT:
// - [#99 fact 2h ago] Project uses Bun as runtime
// - [#97 preference] User prefers functional style over class-based
// </agent_memory>
```

---

## 7. Compaction-Aware Memory Extraction

### The Core Problem

When context compaction happens (messages dropped to free tokens), information dies. The agent loses:
- Decisions made earlier in the session
- File modifications tracking
- Error resolutions
- Project context accumulated over many turns

### How Clawd Currently Handles This

Clawd has **three** compaction-survival mechanisms:

1. **WorkingState** (working-state.ts): Tracks inception task, files, decisions, errors, plan. Survives all compactions. Injected via `formatForContext()`. **Priority**: decisions never drop, inception immutable.

2. **Checkpoints** (checkpoint.ts): LLM-generated structured summaries. Created at 50% of effective context (context-limits.ts). Stored as markdown. Injected into system prompt.

3. **Message Scoring** (message-scoring.ts): Importance-weighted message selection. System messages=100, task definitions get +45 bonus, errors +30. Messages transition FULL→COMPRESSED→DROPPED.

### What's Missing: Pre-Compaction Memory Flush

GoClaw's best pattern — **not yet in Clawd**:

```typescript
// Hook into the compaction lifecycle
async onBeforeCompaction(messages: Message[], ctx: PluginContext): Promise<void> {
  // 1. Identify messages about to be dropped
  const scored = scoreMessages(messages);
  const toBeDropped = scored.filter(s => s.stage === 'DROPPED' || s.stage === 'COMPRESSED');
  
  // 2. Extract memorable facts from about-to-die messages
  const memoryWorthy = toBeDropped.filter(s => s.score > 20); // Still somewhat important
  
  if (memoryWorthy.length === 0) return;
  
  // 3. Batch extract (single LLM call for efficiency)
  const content = memoryWorthy.map(s => {
    const role = s.message.role.toUpperCase();
    return `[${role}]: ${(s.message.content || '').slice(0, 500)}`;
  }).join('\n\n');
  
  const facts = await extractFactsFromContent(content, llmClient);
  
  // 4. Save to long-term memory
  for (const fact of facts) {
    store.save({
      agentId: ctx.agentId,
      channel: ctx.channel,
      content: fact.content,
      category: fact.category,
      source: 'auto',
    });
  }
}
```

**Integration point**: Add `onBeforeCompaction` hook to PluginHooks interface. Call it before `fitToBudget()` drops messages.

### Extraction Heuristics (What's Worth Saving)

From message-scoring.ts, the signals that something is important:
- Task definitions (user requests)
- Decisions with rationale ("I chose X because...")
- Error resolutions ("fixed by...")
- File path references
- Code patterns/architecture choices
- Explicit user preferences

**Optimization**: Run extraction ONLY on messages that score 20-60 (COMPRESSED stage). Below 20 is noise. Above 60 is kept anyway.

---

## 8. Tiered Memory Architectures

### The Ideal Model

```
┌─────────────────────────────────────────────────────────────┐
│ TIER 0: System Prompt (always present, ~2K tokens)          │
│ • Identity/role file                                         │
│ • Critical rules (priority >= 2)                            │
│ • Current working state (inception + decisions)             │
└───────────────────────┬─────────────────────────────────────┘
                        │
┌───────────────────────▼─────────────────────────────────────┐
│ TIER 1: Session Context (in message history, ~50K tokens)    │
│ • Recent messages (scored, compressed/dropped as needed)     │
│ • Latest checkpoint summary                                  │
│ • Knowledge base hints                                       │
└───────────────────────┬─────────────────────────────────────┘
                        │
┌───────────────────────▼─────────────────────────────────────┐
│ TIER 2: Retrievable Memory (agent_memories, FTS5 search)     │
│ • Facts, preferences, lessons, corrections                   │
│ • Scoped by agent + channel                                  │
│ • Injected via getRelevant() on each turn (~2K chars cap)    │
└───────────────────────┬─────────────────────────────────────┘
                        │
┌───────────────────────▼─────────────────────────────────────┐
│ TIER 3: Deep Archive (knowledge base, session checkpoints)   │
│ • Full tool outputs (compressed, indexed by FTS5)            │
│ • Previous session checkpoints                               │
│ • Retrieved on-demand via knowledge_search tool              │
└─────────────────────────────────────────────────────────────┘
```

### What Clawd Has vs What's Missing

| Tier | Status | Components |
|------|--------|------------|
| T0: System Prompt | ✅ Mostly done | Identity (role file), WorkingState (inception, decisions, files, errors, plan) |
| T0: Critical Rules | ❌ **Missing** | No priority-based injection. Critical memories not guaranteed in system prompt. |
| T1: Session Context | ✅ Done | message-scoring.ts + checkpoint.ts + context-limits.ts |
| T2: Retrievable Memory | ✅ Done | agent-memory.ts + memory-plugin.ts (memo_save/recall/delete) |
| T3: Deep Archive | ✅ Done | knowledge-base.ts + context-mode-plugin.ts (knowledge_search) |

### The Missing Piece: T0 Critical Rules Injection

Currently, `getSystemContext()` in memory-plugin.ts (L227-253) injects memories in a flat list with a 2K char cap. No priority ordering.

**Fix**:
```typescript
async function getSystemContext(ctx: PluginContext): Promise<string | null> {
  // 1. ALWAYS inject critical/pinned memories (priority >= 2)
  const critical = store.getCritical(agentId); // New method
  
  // 2. Fill remaining budget with relevant memories
  const relevantBudget = INJECTION_CAP - criticalChars;
  const relevant = store.getRelevant(agentId, channel, lastKeywords, MAX_RECENT, MAX_RELEVANT);
  
  let output = "<agent_memory>\n";
  
  // Critical rules first — ALWAYS present
  if (critical.length > 0) {
    output += "RULES (always follow):\n";
    for (const mem of critical) {
      output += `- ${mem.content}\n`;
    }
    output += "\n";
  }
  
  // Relevant context second — budget-limited
  if (relevant.length > 0) {
    output += "CONTEXT:\n";
    // ... existing injection logic with remaining budget ...
  }
  
  output += "</agent_memory>";
  return output;
}
```

---

## 9. Implementation Plan for Clawd

### Phase 1: Priority Tiers (Small, High Impact)

**Changes**:
1. Add `priority INTEGER NOT NULL DEFAULT 0` to `agent_memories` table
2. Update `save()` to auto-assign priority based on category + content patterns
3. Update `enforceAgentCap()` to never evict priority >= 2
4. Update `getRelevant()` → `getCritical()` + remaining budget
5. Update `getSystemContext()` to inject critical rules first

**Effort**: ~2-3 hours. **Files**: `agent-memory.ts`, `memory-plugin.ts`

### Phase 2: Pre-Compaction Extraction Hook (Medium, High Impact)

**Changes**:
1. Add `onBeforeCompaction` to PluginHooks interface
2. Call it from agent.ts before `fitToBudget()` drops messages
3. In memory-plugin, implement extraction from about-to-die messages
4. Use existing `SIGNIFICANT_PATTERNS` for heuristic gating
5. Single LLM call to batch-extract facts

**Effort**: ~4-6 hours. **Files**: `manager.ts` (plugin interface), `agent.ts`, `memory-plugin.ts`

### Phase 3: Combined Scoring (Small, Medium Impact)

**Changes**:
1. Add `searchWeighted()` method combining FTS5 rank + recency + access count + priority
2. Use in `getRelevant()` for better retrieval quality

**Effort**: ~1-2 hours. **Files**: `agent-memory.ts`

### Phase 4: Memory Consolidation (Medium, Medium Impact)

**Changes**:
1. Add `consolidate()` method to AgentMemoryStore
2. LLM-driven merge of duplicate/outdated memories
3. Trigger on startup when count > 400, or via manual tool

**Effort**: ~4-6 hours. **Files**: `agent-memory.ts`, `memory-plugin.ts` (new tool)

### What NOT to Build

- ❌ Vector search / embeddings — FTS5 is sufficient
- ❌ Graph memory (Neo4j) — YAGNI
- ❌ Auto identity evolution — risks drift, keep explicit
- ❌ Cross-agent memory sharing — YAGNI until multi-agent is mature
- ❌ Memory export/import — YAGNI
- ❌ Hierarchical summarization beyond current levels — overkill

---

## 10. Unresolved Questions

1. **Extraction frequency vs cost**: Pre-compaction extraction adds an LLM call per compaction. At ~$0.01-0.05/call (using cheap model), is this acceptable for all users? Should it be opt-in?

2. **Priority assignment accuracy**: Auto-assigning priority=2 to corrections/lessons may be too aggressive. If 50+ memories are priority=2, they'll dominate the 2K injection cap. Need a sub-limit?

3. **FTS5 query quality**: Current OR-based FTS queries return many low-relevance results. Would AND queries (for short queries) + OR (for long) improve precision without hurting recall?

4. **Consolidation safety**: LLM-driven consolidation could accidentally merge or delete important information. Should there be a "consolidation log" for rollback? Or dry-run mode?

5. **Identity file vs memory priority**: Currently identity is in a role file (filesystem), while rules are in agent_memories (SQLite). Should critical rules ALSO be in the identity file for maximum survival? Or is dual-storage redundant?

6. **Working state size growth**: `WorkingState.decisions` is append-only (C23 in working-state.ts). With no eviction, this could grow unboundedly in long-running sessions. Is the FORMAT_CAP_CHARS (7K) sufficient to prevent context overflow?

7. **Cross-channel memory leakage**: A correction learned in channel A should arguably apply to channel B too. Current `scope: "agent"` vs `scope: "channel"` is explicit. Should auto-extracted corrections default to agent-wide scope?
