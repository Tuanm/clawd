/**
 * Memory Plugin — Per-agent long-term memory with auto-injection & auto-extraction
 *
 * Compound plugin factory returning { plugin, toolPlugin }:
 * - Plugin: getSystemContext (inject relevant memories), onAgentResponse (auto-extract)
 * - ToolPlugin: memo_save, memo_recall, memo_delete, identity_update
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  type AgentMemory,
  AgentMemoryStore,
  extractKeywords,
  getAgentMemoryStore,
  type MemoryCategory,
} from "../memory/agent-memory";
import type { ToolPlugin, ToolRegistration } from "../tools/plugin";
import type { ToolResult } from "../tools/tools";
import type { Plugin, PluginContext, PluginHooks } from "./manager";

// ── Config ─────────────────────────────────────────────────────────

export interface MemoryPluginConfig {
  agentId: string;
  channel: string;
  projectRoot: string;
  /** Memory-specific LLM provider (optional) */
  memoryProvider?: string;
  /** Memory-specific model (optional) */
  memoryModel?: string;
  /** Enable auto-extraction from responses (default: true) */
  autoExtract?: boolean;
  /** Custom db path (for testing) */
  dbPath?: string;
}

// ── Result Type ────────────────────────────────────────────────────

export interface MemoryPluginResult {
  plugin: Plugin;
  toolPlugin: ToolPlugin;
  destroy: () => void;
}

// ── Constants ──────────────────────────────────────────────────────

const INJECTION_CAP = 4000; // 4K chars max for memory context
const MAX_RECENT = 5;
const MAX_RELEVANT = 10;
const MIN_IDENTITY_LENGTH = 50;
const MAX_IDENTITY_LENGTH = 10_000;
const VALID_CATEGORIES: MemoryCategory[] = ["fact", "preference", "decision", "lesson", "correction"];

// Heuristic pre-filter: skip extraction for trivial responses
const SIGNIFICANT_PATTERNS = [
  /\b(?:decided|prefer|always|never|remember|important|note|learned|key|must|should)\b/i,
  /\b(?:bug|fix|error|issue|solution|pattern|approach|architecture|config)\b/i,
  /\b(?:user wants|user prefers|requirement|constraint|deadline)\b/i,
  /\b(?:endpoint|url|port|host)\b/i,
  /```[\s\S]{20,}```/, // Code blocks
];

// Block extraction when secrets are detected
const SECRET_PATTERNS = [
  /\b(?:password|token|secret|api[_-]?key)\s*[:=]\s*\S+/i,
  /\b(?:sk-|ghp_|gho_|xoxb-|xoxp-|AKIA)\S{10,}/,
];

// ── Factory ────────────────────────────────────────────────────────

export function createMemoryPlugin(config: MemoryPluginConfig): MemoryPluginResult {
  const store = config.dbPath ? new AgentMemoryStore(config.dbPath) : getAgentMemoryStore();
  const { agentId, channel, projectRoot } = config;
  let turnCount = 0;
  let extractionFailures = 0;

  // ── Tool Handlers ──────────────────────────────────────────────

  async function handleMemoSave(args: Record<string, any>): Promise<ToolResult> {
    const content = args.content;
    if (!content || typeof content !== "string" || !content.trim()) {
      return { success: false, output: "", error: "Content is required" };
    }

    const category = args.category as MemoryCategory | undefined;
    if (category && !VALID_CATEGORIES.includes(category)) {
      return {
        success: false,
        output: "",
        error: `Invalid category "${category}". Valid: ${VALID_CATEGORIES.join(", ")}`,
      };
    }

    // channel scope: use args.scope to save agent-wide if requested
    const memChannel = args.scope === "agent" ? null : channel;

    const result = store.save({
      agentId,
      channel: memChannel,
      content: content.trim(),
      category,
      source: "explicit",
    });

    if (result.id === null) {
      return {
        success: false,
        output: "",
        error: result.warning || "Failed to save memory",
      };
    }

    const output = result.warning
      ? `Memory #${result.id} saved (${result.warning})`
      : `Memory #${result.id} saved successfully`;

    return { success: true, output };
  }

  async function handleMemoRecall(args: Record<string, any>): Promise<ToolResult> {
    const results = store.recall({
      agentId,
      channel,
      query: args.query,
      category: args.category as MemoryCategory | undefined,
      limit: args.limit,
      offset: args.offset,
      includeGlobal: true,
    });

    if (results.length === 0) {
      return {
        success: true,
        output: args.query ? `No memories found matching "${args.query}"` : "No memories saved yet",
      };
    }

    const lines = results.map((m) => {
      const age = formatAge(m.createdAt);
      const scope = m.channel ? "" : " [agent-wide]";
      const pin = m.priority >= 80 ? " 📌" : "";
      return `#${m.id} [${m.category}] (${age}${scope}${pin}): ${m.content}`;
    });

    const header = args.query
      ? `Found ${results.length} memories matching "${args.query}":`
      : `Recent ${results.length} memories:`;

    return { success: true, output: `${header}\n${lines.join("\n")}` };
  }

  async function handleMemoDelete(args: Record<string, any>): Promise<ToolResult> {
    const id = Number(args.id);
    if (!id || isNaN(id)) {
      return { success: false, output: "", error: "Valid memory ID required" };
    }

    const deleted = store.delete(id, agentId);
    if (!deleted) {
      return {
        success: false,
        output: "",
        error: `Memory #${id} not found or not owned by you`,
      };
    }

    return { success: true, output: `Memory #${id} deleted` };
  }

  async function handleMemoPin(args: Record<string, any>): Promise<ToolResult> {
    const id = Number(args.id);
    if (!id || isNaN(id)) {
      return { success: false, output: "", error: "Valid memory ID required" };
    }
    const result = store.pin(id, agentId);
    if (!result.success) {
      return {
        success: false,
        output: "",
        error: result.error || "Failed to pin",
      };
    }
    return {
      success: true,
      output: `Memory #${id} pinned — it will always be loaded into your context.`,
    };
  }

  async function handleMemoUnpin(args: Record<string, any>): Promise<ToolResult> {
    const id = Number(args.id);
    if (!id || isNaN(id)) {
      return { success: false, output: "", error: "Valid memory ID required" };
    }
    const result = store.unpin(id, agentId);
    if (!result.success) {
      return {
        success: false,
        output: "",
        error: result.error || "Failed to unpin",
      };
    }
    return {
      success: true,
      output: `Memory #${id} unpinned — it will only be loaded when relevant.`,
    };
  }

  async function handleIdentityUpdate(args: Record<string, any>): Promise<ToolResult> {
    const content = args.content;
    if (!content || typeof content !== "string") {
      return {
        success: false,
        output: "",
        error: "Content is required (string)",
      };
    }

    const trimmed = content.trim();
    if (trimmed.length < MIN_IDENTITY_LENGTH) {
      return {
        success: false,
        output: "",
        error: `Identity must be at least ${MIN_IDENTITY_LENGTH} characters (got ${trimmed.length})`,
      };
    }
    if (trimmed.length > MAX_IDENTITY_LENGTH) {
      return {
        success: false,
        output: "",
        error: `Identity must be at most ${MAX_IDENTITY_LENGTH} characters (got ${trimmed.length})`,
      };
    }

    try {
      // Sanitize agentId for filesystem safety
      const safeId = agentId.replace(/[^a-zA-Z0-9_-]/g, "_");
      const agentsDir = join(projectRoot, ".clawd", "agents");
      mkdirSync(agentsDir, { recursive: true });

      const agentPath = join(agentsDir, `${safeId}.md`);
      // Defense-in-depth: verify path stays within agentsDir
      const { resolve: resolvePath } = await import("node:path");
      const resolvedAgent = resolvePath(agentPath);
      const resolvedAgentsDir = resolvePath(agentsDir);
      if (!resolvedAgent.startsWith(resolvedAgentsDir + "/")) {
        return {
          success: false,
          output: "",
          error: "Invalid agent ID for path",
        };
      }

      // Write agent file with frontmatter
      const fileContent = `---\nname: ${safeId}\n---\n\n${trimmed}`;
      writeFileSync(agentPath, fileContent, "utf-8");

      return {
        success: true,
        output: `Identity updated (${trimmed.length} chars). Changes take effect on next iteration.`,
      };
    } catch (err: any) {
      return {
        success: false,
        output: "",
        error: `Failed to update identity: ${err.message}`,
      };
    }
  }

  // ── Auto-Injection (getSystemContext) ──────────────────────────

  async function getSystemContext(ctx: PluginContext): Promise<string | null> {
    try {
      const memories = store.getRelevant(agentId, channel, lastKeywords, MAX_RECENT, MAX_RELEVANT);
      if (memories.length === 0 && compactionCount === 0) return null;

      // Build actually-injected IDs list during rendering
      const actuallyInjectedIds: number[] = [];

      let output = "<agent_memory>\n";
      let charCount = 0;

      // Session DNA — orientation context after compactions
      if (compactionCount > 0) {
        const dna =
          `  <session_dna compactions="${compactionCount}" turn="${turnCount}">\n` +
          `    This is a long-running session. ${compactionCount} compaction(s) have occurred.\n` +
          `    Your pinned memories and extracted facts below persist across compactions.\n` +
          `  </session_dna>\n`;
        output += dna;
        charCount += dna.length;
      }

      // Separate pinned vs non-pinned
      const pinned = memories.filter((m) => m.priority >= 80);
      const others = memories.filter((m) => m.priority < 80);

      // Pinned rules section — always included (up to 1500 chars)
      if (pinned.length > 0) {
        output += "  <pinned_rules>\n";
        let pinnedIncluded = 0;
        for (const mem of pinned) {
          const line = `    - [#${mem.id} ${mem.category}] ${mem.content}\n`;
          if (charCount + line.length > 1500) break;
          output += line;
          charCount += line.length;
          pinnedIncluded++;
          actuallyInjectedIds.push(mem.id);
        }
        if (pinnedIncluded < pinned.length) {
          output += `    (${pinned.length - pinnedIncluded} pinned memories truncated — unpin some to free space)\n`;
        }
        output += "  </pinned_rules>\n";
      }

      // Relevant + recent section
      if (others.length > 0) {
        output += "  <relevant>\n";
        for (const mem of others) {
          const age = formatAge(mem.createdAt);
          const line = `    - [#${mem.id} ${mem.category} ${age}] ${mem.content}\n`;
          if (charCount + line.length > INJECTION_CAP) break;
          output += line;
          charCount += line.length;
          actuallyInjectedIds.push(mem.id);
        }
        output += "  </relevant>\n";
      }

      // Track only actually injected IDs for Phase 4 reflection
      lastInjectedIds = actuallyInjectedIds;

      // Memory hints — tell agent what topics it knows about (Phase 4)
      if (charCount < INJECTION_CAP - 200) {
        const hints = store.getMemoryHints(agentId);
        if (hints) {
          const hintsSection = `  <memory_topics>\n${hints
            .split("\n")
            .map((h: string) => `    ${h}`)
            .join("\n")}\n  </memory_topics>\n`;
          if (charCount + hintsSection.length <= INJECTION_CAP) {
            output += hintsSection;
            charCount += hintsSection.length;
          }
        }
      }

      output += "</agent_memory>";
      return output;
    } catch {
      // Silent fail — don't break agent loop
      return null;
    }
  }

  // Track recent keywords for injection relevance
  let lastKeywords: string[] = [];

  // ── Auto-Extraction (onAgentResponse) ─────────────────────────

  let lastConsolidationTurn = 0;
  let consolidationRunning = false; // Prevent concurrent fire-and-forget consolidation
  const CONSOLIDATION_COOLDOWN = 50; // Min turns between consolidations
  const MEMORY_CAP_THRESHOLD = 1600; // 80% of MAX_MEMORIES_PER_AGENT (2000)

  async function onAgentResponse(response: any, ctx: PluginContext): Promise<void> {
    turnCount++;

    // Volume-triggered consolidation — event-driven with cooldown
    // Check count only every 25 turns to avoid per-turn DB query
    if (turnCount % 25 === 0) {
      const memoryCount = store.getCount(agentId);
      const needsConsolidation = memoryCount >= MEMORY_CAP_THRESHOLD || turnCount % 200 === 0;
      if (needsConsolidation && !consolidationRunning && turnCount - lastConsolidationTurn >= CONSOLIDATION_COOLDOWN) {
        lastConsolidationTurn = turnCount;
        consolidationRunning = true;
        consolidateMemories(ctx)
          .catch(() => {})
          .finally(() => {
            consolidationRunning = false;
          });
      }
    }
    // Note: turnCount % 200 is already handled above (200 is divisible by 25)

    // Reflection every 100 turns (staggered with consolidation)
    if (turnCount % 100 === 0 && turnCount > 10 && turnCount !== lastConsolidationTurn) {
      reflectOnMemories(ctx).catch(() => {
        /* best-effort */
      });
    }

    // Priority decay every 50 turns (lightweight, no LLM)
    if (turnCount % 50 === 0 && turnCount > 10) {
      try {
        store.decayPriorities(agentId);
      } catch {}
    }

    // Update keywords from recent context
    if (response?.content) {
      lastKeywords = extractKeywords(response.content).slice(0, 15);
    }

    // Skip auto-extraction if disabled
    if (config.autoExtract === false) return;

    // Heuristic gating: skip trivial responses
    const content = response?.content || "";
    if (content.length < 100) return;
    if (turnCount <= 2) return; // Skip first 2 turns (usually greetings/setup)

    // Check if content has significant patterns
    const hasSignificant = SIGNIFICANT_PATTERNS.some((p) => p.test(content));
    if (!hasSignificant) return;

    // Block extraction of content containing secrets
    if (SECRET_PATTERNS.some((p) => p.test(content))) return;

    // Fire-and-forget async extraction
    extractMemories(content, ctx).catch(() => {
      extractionFailures++;
    });
  }

  async function extractMemories(content: string, ctx: PluginContext): Promise<void> {
    // Use LLM to extract facts
    const llmClient = ctx.llmClient;
    if (!llmClient) return;

    const extractionPrompt = `Extract key facts, decisions, preferences, or lessons from the following agent response. Return a JSON array of objects with "content" (string, one atomic fact) and "category" (one of: fact, preference, decision, lesson, correction). Only extract genuinely important information worth remembering long-term. Return [] if nothing worth extracting. Max 5 items. Return ONLY the JSON array, no explanation.

Response to analyze:
${content.slice(0, 2000)}`;

    try {
      const result = await llmClient.complete({
        model: config.memoryModel || llmClient.model,
        messages: [{ role: "user", content: extractionPrompt }],
        max_tokens: 300,
      });

      const responseText = result?.choices?.[0]?.message?.content || "";
      // Parse JSON array — use balanced bracket matching to avoid greedy over-match
      const jsonArray = extractFirstJsonArray(responseText);
      if (!jsonArray) return;

      const facts = JSON.parse(jsonArray) as Array<{
        content: string;
        category: string;
      }>;
      if (!Array.isArray(facts)) return;

      for (const fact of facts.slice(0, 5)) {
        if (!fact.content || typeof fact.content !== "string") continue;
        const category = VALID_CATEGORIES.includes(fact.category as MemoryCategory)
          ? (fact.category as MemoryCategory)
          : "fact";

        store.save({
          agentId,
          channel,
          content: fact.content.trim(),
          category,
          source: "auto",
          priority: 40,
        });
      }
    } catch {
      // Silent fail — extraction is best-effort
      extractionFailures++;
    }
  }

  // ── Memory Consolidation (Phase 3) ────────────────────────────

  /**
   * Periodically merge similar memories to reduce duplicates.
   * Uses LLM to merge groups of similar memories in the same category.
   */
  async function consolidateMemories(ctx: PluginContext): Promise<void> {
    const llmClient = ctx.llmClient;
    if (!llmClient) return;

    const groups = store.findConsolidationCandidates(agentId);
    if (groups.length === 0) return;

    let merged = 0;
    for (const group of groups.slice(0, 3)) {
      // Max 3 categories per consolidation run
      // Find clusters of similar memories within the category
      const memories = group.memories;
      if (memories.length < 5) continue;

      // Simple cluster: group by content similarity (Jaccard on keywords)
      const clusters: AgentMemory[][] = [];
      const used = new Set<number>();

      for (let i = 0; i < memories.length; i++) {
        if (used.has(memories[i].id)) continue;
        const cluster = [memories[i]];
        used.add(memories[i].id);
        const iWords = new Set(extractKeywords(memories[i].content));

        for (let j = i + 1; j < memories.length; j++) {
          if (used.has(memories[j].id)) continue;
          const jWords = new Set(extractKeywords(memories[j].content));
          const intersection = [...iWords].filter((w) => jWords.has(w)).length;
          const union = new Set([...iWords, ...jWords]).size;
          if (union > 0 && intersection / union >= 0.3) {
            cluster.push(memories[j]);
            used.add(memories[j].id);
          }
        }

        if (cluster.length >= 2) {
          clusters.push(cluster);
        }
      }

      // LLM merge each cluster
      for (const cluster of clusters.slice(0, 3)) {
        try {
          const items = cluster.map((m) => `- [#${m.id}] ${m.content}`).join("\n");
          const result = await llmClient.complete({
            model: config.memoryModel || llmClient.model,
            messages: [
              {
                role: "user",
                content: `Merge these related memories into a single, comprehensive memory. Preserve all unique information. Return ONLY the merged text, no explanation.\n\n${items}`,
              },
            ],
            max_tokens: 300,
            temperature: 0,
          });

          const mergedContent = result?.choices?.[0]?.message?.content?.trim();
          if (mergedContent && mergedContent.length > 10) {
            const mergeIds = cluster.map((m) => m.id);
            store.mergeMemories(agentId, mergeIds, mergedContent, group.category);
            merged += cluster.length;
          }
        } catch {
          // Skip this cluster
        }
      }
    }

    if (merged > 0) {
      console.log(`[Memory] Consolidation: merged ${merged} memories into fewer entries`);
    }
  }

  // ── Self-Reflection (Phase 4) ─────────────────────────────────

  /** Track which memory IDs were injected in the last context */
  let lastInjectedIds: number[] = [];

  /**
   * Reflect on recently injected memories: which were critical vs irrelevant?
   * Uses LLM to evaluate and adjusts effectiveness + priority accordingly.
   */
  async function reflectOnMemories(ctx: PluginContext): Promise<void> {
    const llmClient = ctx.llmClient;
    if (!llmClient || lastInjectedIds.length === 0) return;

    // Fetch the exact memories that were injected (without bumping access counts)
    const nonPinnedIds = lastInjectedIds.slice(0, 15);
    const injected = store.getByIds(nonPinnedIds, agentId).filter((m) => m.priority < 80);
    if (injected.length === 0) return;

    try {
      const memList = injected.map((m) => `#${m.id} [${m.category}]: ${m.content}`).join("\n");
      const result = await llmClient.complete({
        model: config.memoryModel || llmClient.model,
        messages: [
          {
            role: "user",
            content: `Evaluate these memories that were loaded into your context. For each, rate how useful it was for the recent conversation. Return a JSON array of objects with "id" (number) and "rating" ("critical"|"useful"|"neutral"|"irrelevant"). Return ONLY the JSON array.\n\nMemories:\n${memList}`,
          },
        ],
        max_tokens: 500,
        temperature: 0,
      });

      const text = result?.choices?.[0]?.message?.content?.trim();
      if (!text) return;

      const jsonMatch = text.match(/\[[\s\S]*\]/);
      if (!jsonMatch) return;
      const ratings = JSON.parse(jsonMatch[0]);
      if (!Array.isArray(ratings)) return;

      const validIds = new Set(injected.map((m) => m.id));
      const updates: { id: number; delta: number; priorityDelta?: number }[] = [];
      for (const r of ratings) {
        if (typeof r.id !== "number" || !validIds.has(r.id) || !r.rating) continue;
        switch (r.rating) {
          case "critical":
            updates.push({ id: r.id, delta: 0.1, priorityDelta: 5 });
            break;
          case "useful":
            updates.push({ id: r.id, delta: 0.05, priorityDelta: 2 });
            break;
          case "irrelevant":
            updates.push({ id: r.id, delta: -0.1, priorityDelta: -5 });
            break;
          // "neutral" — no change
        }
      }

      if (updates.length > 0) {
        const changed = store.updateEffectiveness(updates, agentId);
        if (changed > 0) {
          console.log(`[Memory] Reflection: updated effectiveness for ${changed} memories`);
        }
      }
    } catch {
      // Best-effort
    }
  }

  // ── Compaction Harvest (Phase 2) ──────────────────────────────

  let compactionCount = 0;

  /**
   * Before compaction: extract critical facts from messages about to be dropped.
   * This ensures decisions, preferences, and lessons survive context compaction.
   */
  async function beforeCompaction(droppedMessages: any[], ctx: PluginContext): Promise<void> {
    const llmClient = ctx.llmClient;
    if (!llmClient) return;

    // Build a condensed text from dropped messages (cap at 8K chars to control cost)
    const condensed: string[] = [];
    let charBudget = 8000;
    for (const msg of droppedMessages) {
      const content = typeof msg.content === "string" ? msg.content : "";
      if (!content || content.length < 20) continue;
      // Skip tool results (often verbose, low signal)
      if (msg.role === "tool") continue;
      const snippet = content.length > 500 ? content.slice(0, 500) + "..." : content;
      if (charBudget - snippet.length < 0) break;
      condensed.push(`[${msg.role}] ${snippet}`);
      charBudget -= snippet.length;
    }

    if (condensed.length === 0) return;

    try {
      const result = await llmClient.complete({
        model: config.memoryModel || llmClient.model,
        messages: [
          {
            role: "user",
            content: `These messages are about to be lost from context (compaction #${compactionCount}). Extract the most critical information that should be remembered long-term. Focus on: user decisions, user preferences, project-specific rules, important corrections, critical bugs discovered, and architectural decisions.

Return a JSON array of objects with "content" (one atomic fact), "category" (fact|preference|decision|lesson|correction), and "priority" (40-70, higher = more important). Return [] if nothing critical. Max 8 items. Return ONLY the JSON array.

Messages being dropped:
${condensed.join("\n")}`,
          },
        ],
        max_tokens: 1000,
        temperature: 0,
      });

      const text = result?.choices?.[0]?.message?.content?.trim();
      if (!text) return;

      // Parse JSON array
      const jsonMatch = text.match(/\[[\s\S]*\]/);
      if (!jsonMatch) return;
      const items = JSON.parse(jsonMatch[0]);
      if (!Array.isArray(items)) return;

      let saved = 0;
      for (const item of items.slice(0, 8)) {
        if (!item.content || typeof item.content !== "string") continue;
        const cat = VALID_CATEGORIES.includes(item.category) ? item.category : "fact";
        const priority = Math.max(40, Math.min(70, Number(item.priority) || 50));
        const result = store.save({
          agentId,
          channel: config.channel,
          content: item.content,
          category: cat,
          source: "auto",
          priority,
          tags: extractKeywords(item.content).slice(0, 5).join(","),
        });
        if (result.id) saved++;
      }

      if (saved > 0) {
        console.log(
          `[Memory] Compaction harvest: saved ${saved} memories from ${droppedMessages.length} dropped messages`,
        );
      }
    } catch {
      // Best-effort — don't block compaction
    }
  }

  // ── Plugin Hooks ───────────────────────────────────────────────

  const pluginHooks: PluginHooks = {
    getSystemContext,
    onAgentResponse,
    beforeCompaction,
    async onCompaction(_deleted: number, _remaining: number) {
      // Track compaction count here — fires on ALL compaction paths (smart, legacy, critical, overflow)
      compactionCount++;
    },
    async onUserMessage(message: string) {
      // Update keywords from user message for injection relevance
      lastKeywords = extractKeywords(message).slice(0, 15);
    },
    async onShutdown() {
      // Don't close singleton store
    },
  };

  const plugin: Plugin = {
    name: "agent-memory",
    version: "1.0.0",
    description: "Per-agent long-term memory with auto-extraction and selective injection",
    hooks: pluginHooks,
  };

  // ── Tool Plugin ────────────────────────────────────────────────

  const toolPlugin: ToolPlugin = {
    name: "agent-memory",
    getTools(): ToolRegistration[] {
      return [
        {
          name: "memo_save",
          description:
            "Save important information to your long-term memory. Memories persist across sessions and are scoped to you. Use categories: fact, preference, decision, lesson, correction. Use memo_pin to ensure critical memories are always loaded.",
          parameters: {
            content: {
              type: "string",
              description: "The information to remember (be specific and atomic — one fact per save)",
            },
            category: {
              type: "string",
              description: "Memory category",
              enum: ["fact", "preference", "decision", "lesson", "correction"],
              default: "fact",
            },
            scope: {
              type: "string",
              description: '"channel" (default) = this channel only, "agent" = remember across all channels',
              enum: ["channel", "agent"],
              default: "channel",
            },
          },
          required: ["content"],
          handler: handleMemoSave,
        },
        {
          name: "memo_recall",
          description:
            "Search your long-term memories. Without a query, returns recent memories. Use to recall previously saved facts, decisions, preferences, and lessons.",
          parameters: {
            query: {
              type: "string",
              description: "Search keywords (optional — omit to see recent memories)",
            },
            category: {
              type: "string",
              description: "Filter by category",
              enum: ["fact", "preference", "decision", "lesson", "correction"],
            },
            limit: {
              type: "number",
              description: "Max results (default: 20, max: 50)",
              default: 20,
            },
            offset: {
              type: "number",
              description: "Offset for pagination (default: 0)",
              default: 0,
            },
          },
          required: [],
          handler: handleMemoRecall,
        },
        {
          name: "memo_delete",
          description: "Delete a memory by its ID. Use memo_recall to find IDs first.",
          parameters: {
            id: {
              type: "number",
              description: "Memory ID to delete",
            },
          },
          required: ["id"],
          handler: handleMemoDelete,
        },
        {
          name: "memo_pin",
          description:
            "Pin a memory so it is ALWAYS loaded into your context. Use for critical rules, important decisions, and must-remember facts. Max 25 pinned memories. Find IDs with memo_recall.",
          parameters: {
            id: {
              type: "number",
              description: "Memory ID to pin",
            },
          },
          required: ["id"],
          handler: handleMemoPin,
        },
        {
          name: "memo_unpin",
          description: "Unpin a previously pinned memory. It will still exist but only loaded when relevant.",
          parameters: {
            id: {
              type: "number",
              description: "Memory ID to unpin",
            },
          },
          required: ["id"],
          handler: handleMemoUnpin,
        },
        {
          name: "identity_update",
          description:
            "Update your own identity/role file. This changes how you behave and is loaded into your system prompt. Use to refine your personality, expertise areas, or behavioral rules based on experience.",
          parameters: {
            content: {
              type: "string",
              description:
                "Your complete identity content (markdown). Must be 50-10000 chars. Include your role, expertise, behavioral rules, communication style, etc.",
            },
          },
          required: ["content"],
          handler: handleIdentityUpdate,
        },
      ];
    },
    async destroy() {
      // Don't close singleton store — other plugins may use it
    },
  };

  return {
    plugin,
    toolPlugin,
    destroy: () => {
      // Cleanup if needed
    },
  };
}

// ── Helpers ────────────────────────────────────────────────────────

function formatAge(unixSeconds: number): string {
  const now = Math.floor(Date.now() / 1000);
  const diff = now - unixSeconds;

  if (diff < 60) return "just now";
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  if (diff < 604800) return `${Math.floor(diff / 86400)}d ago`;
  return `${Math.floor(diff / 604800)}w ago`;
}

/** Find the first balanced JSON array [...] in text */
function extractFirstJsonArray(text: string): string | null {
  // Strip markdown code fences
  const cleaned = text.replace(/```(?:json)?\s*/g, "").replace(/```/g, "");
  const start = cleaned.indexOf("[");
  if (start === -1) return null;
  let depth = 0;
  for (let i = start; i < cleaned.length; i++) {
    if (cleaned[i] === "[") depth++;
    else if (cleaned[i] === "]") {
      depth--;
      if (depth === 0) return cleaned.slice(start, i + 1);
    }
  }
  return null;
}

/**
 * Check if memory is enabled from config.
 */
export function isMemoryEnabled(
  memoryConfig: boolean | { provider?: string; model?: string; autoExtract?: boolean } | undefined,
): boolean {
  if (memoryConfig === true) return true;
  if (memoryConfig && typeof memoryConfig === "object") return true;
  return false;
}
