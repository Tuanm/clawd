/**
 * Memory Plugin — Per-agent long-term memory with auto-injection & auto-extraction
 *
 * Compound plugin factory returning { plugin, toolPlugin }:
 * - Plugin: getSystemContext (inject relevant memories), onAgentResponse (auto-extract)
 * - ToolPlugin: memo_save, memo_recall, memo_delete, identity_update
 */

import type { Plugin, PluginHooks, PluginContext } from "./manager";
import type { ToolPlugin, ToolRegistration } from "../tools/plugin";
import type { ToolResult } from "../tools/tools";
import {
  AgentMemoryStore,
  getAgentMemoryStore,
  extractKeywords,
  type MemoryCategory,
  type AgentMemory,
} from "../memory/agent-memory";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

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

const INJECTION_CAP = 2000; // 2K chars max for memory context
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
      return { success: false, output: "", error: result.warning || "Failed to save memory" };
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
      return `#${m.id} [${m.category}] (${age}${scope}): ${m.content}`;
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
      return { success: false, output: "", error: `Memory #${id} not found or not owned by you` };
    }

    return { success: true, output: `Memory #${id} deleted` };
  }

  async function handleIdentityUpdate(args: Record<string, any>): Promise<ToolResult> {
    const content = args.content;
    if (!content || typeof content !== "string") {
      return { success: false, output: "", error: "Content is required (string)" };
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
      const rolesDir = join(projectRoot, ".clawd", "roles");
      mkdirSync(rolesDir, { recursive: true });

      const rolePath = join(rolesDir, `${safeId}.md`);
      // Defense-in-depth: verify path stays within rolesDir
      const { resolve: resolvePath } = await import("node:path");
      const resolvedRole = resolvePath(rolePath);
      const resolvedRolesDir = resolvePath(rolesDir);
      if (!resolvedRole.startsWith(resolvedRolesDir + "/")) {
        return { success: false, output: "", error: "Invalid agent ID for path" };
      }
      writeFileSync(rolePath, trimmed, "utf-8");

      // Upsert role in agents.json (re-read before write to narrow race window)
      const agentsJsonPath = join(projectRoot, ".clawd", "agents.json");
      let agentsConfig: Record<string, any> = {};
      if (existsSync(agentsJsonPath)) {
        try {
          agentsConfig = JSON.parse(readFileSync(agentsJsonPath, "utf-8"));
        } catch {}
      }
      if (!agentsConfig[agentId]) agentsConfig[agentId] = {};
      const roles: string[] = agentsConfig[agentId].roles || [];
      if (!roles.includes(agentId)) {
        roles.push(agentId);
        agentsConfig[agentId].roles = roles;
      }
      writeFileSync(agentsJsonPath, JSON.stringify(agentsConfig, null, 2), "utf-8");

      return {
        success: true,
        output: `Identity updated (${trimmed.length} chars). Changes take effect on next iteration.`,
      };
    } catch (err: any) {
      return { success: false, output: "", error: `Failed to update identity: ${err.message}` };
    }
  }

  // ── Auto-Injection (getSystemContext) ──────────────────────────

  async function getSystemContext(ctx: PluginContext): Promise<string | null> {
    try {
      const memories = store.getRelevant(agentId, channel, lastKeywords, MAX_RECENT, MAX_RELEVANT);
      if (memories.length === 0) return null;

      let output = "<agent_memory>\n";
      let charCount = 0;

      for (const mem of memories) {
        const age = formatAge(mem.createdAt);
        const line =
          mem.category === "fact" || mem.category === "correction"
            ? `- [#${mem.id} ${mem.category} ${age}] ${mem.content}\n`
            : `- [#${mem.id} ${mem.category}] ${mem.content}\n`;

        if (charCount + line.length > INJECTION_CAP) break;
        output += line;
        charCount += line.length;
      }

      output += "</agent_memory>";
      return output;
    } catch (err) {
      // Silent fail — don't break agent loop
      return null;
    }
  }

  // Track recent keywords for injection relevance
  let lastKeywords: string[] = [];

  // ── Auto-Extraction (onAgentResponse) ─────────────────────────

  async function onAgentResponse(response: any, ctx: PluginContext): Promise<void> {
    turnCount++;

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

      const facts = JSON.parse(jsonArray) as Array<{ content: string; category: string }>;
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
        });
      }
    } catch {
      // Silent fail — extraction is best-effort
      extractionFailures++;
    }
  }

  // ── Plugin Hooks ───────────────────────────────────────────────

  const pluginHooks: PluginHooks = {
    getSystemContext,
    onAgentResponse,
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
            "Save important information to your long-term memory. Memories persist across sessions and are scoped to you. Use categories: fact, preference, decision, lesson, correction.",
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
