/**
 * Context Mode Plugin — FTS5 knowledge base + tool output compression
 * Phase 3.2: Factory function returning { plugin, toolPlugin, compressToolResult }
 *
 * The compressToolResult method is called directly from agent.ts executeSingleToolCall,
 * NOT via afterExecute (to avoid double-compression).
 */

import { KnowledgeBase } from "../memory/knowledge-base";
import type { ToolResult } from "../tools/definitions";
import type { ToolContext, ToolPlugin, ToolRegistration } from "../tools/plugin";
import { type CompressResult, compressToolOutput, getToolCap } from "../utils/output-compressor";
import type { Plugin, PluginHooks } from "./manager";

// ── Keyword Stop Words (module-level for single compilation) ───────
// Shared stop words for both code and prose — common tokens with low semantic value.
// Using the same list for both (no separate CODE_STOP_WORDS) keeps keyword extraction
// simple and consistent. Code-specific keywords like function/class are included here
// because they appear in both prose ("I need a function that...") and code contexts
// and add little semantic value when searching for relevant tool output.
const SHARED_STOP_WORDS =
  /^(this|that|with|from|have|been|will|were|they|then|than|also|just|more|some|only|very|each|when|what|into|error|undefined|null|true|false|void|typeof|value|result|index|data|args|name|test|spec)$/;

/**
 * Detect if text is primarily code (has syntax indicators) or prose.
 */
function isCodeContent(text: string): boolean {
  const codeIndicators = [
    /^(import|export|const|let|var|function|class|interface|type|enum|async|await|return|if|else|for|while|switch|case|try|catch|throw|finally)\s/m,
    /[{}[\]();]=>/.test(text), // braces, brackets, semicolons, arrow functions
    /\/\*[\s\S]*?\*\/|\/\/.+/.test(text), // comments
    /['"`][^'"`]*['"`]\s*[=:.]/.test(text), // string literals
    /\d+\.\d+/.test(text), // numbers
    /[A-Z][a-z]+[A-Z]/.test(text), // PascalCase
  ];
  return codeIndicators.filter(Boolean).length >= 2;
}

/** Get the stop words regex — shared for both code and prose */
function getStopWords(_text: string): RegExp {
  return SHARED_STOP_WORDS;
}

// ── Config ─────────────────────────────────────────────────────────

interface ContextModeConfig {
  sessionId: string;
  sessionDir: string;
  channel?: string;
  dbPath?: string;
  /** Callback for manual compaction — set by agent.ts */
  onCompactRequest?: () => Promise<{ before: number; after: number }>;
}

// ── Result Type ────────────────────────────────────────────────────

export interface ContextModePluginResult {
  plugin: Plugin;
  toolPlugin: ToolPlugin;
  /** Call from agent.ts executeSingleToolCall — THE single compression point */
  compressToolResult: (toolName: string, result: ToolResult) => CompressResult;
  /** Clean up resources */
  destroy: () => void;
}

// ── Factory ────────────────────────────────────────────────────────

export function createContextModePlugin(config: ContextModeConfig): ContextModePluginResult {
  const kb = new KnowledgeBase(config.dbPath);
  let totalIndexed = 0;
  let totalSaved = 0;

  // ── Intent-driven filtering (5.1) ─────────────────────────────
  // Recent keywords for auto-relevance matching after compression
  const recentKeywords: string[] = [];
  const MAX_RECENT_KEYWORDS = 20;

  function updateRecentKeywords(text: string): void {
    // Use content-type-aware stop words (fix: preserve code keywords like function/class/return)
    const stopWords = getStopWords(text);
    const words = text
      .toLowerCase()
      .split(/\W+/)
      .filter(
        (w) =>
          w.length >= 4 &&
          !stopWords.test(w) &&
          !/^\d+$/.test(w) && // filter pure numbers
          /[a-z]{2,}/.test(w), // require at least 2 consecutive letters
      );
    const unique = [...new Set(words)];
    for (const w of unique.slice(0, 10)) {
      if (!recentKeywords.includes(w)) {
        recentKeywords.push(w);
        if (recentKeywords.length > MAX_RECENT_KEYWORDS) recentKeywords.shift();
      }
    }
  }

  // ── compressToolResult — THE compression interception point ───

  function compressToolResult(toolName: string, result: ToolResult): CompressResult {
    try {
      // Type guard (C27: compression never drops)
      if (!result || typeof result.output !== "string") {
        return {
          result: result || { success: false, output: "", error: "No result" },
          indexed: false,
          originalSize: 0,
          compressedSize: 0,
        };
      }

      // Fix: Reserve snippet space BEFORE compression so intent snippets don't挤占 truncated content
      const cap = getToolCap(toolName);
      const snippetReserve = recentKeywords.length > 0 ? Math.min(Math.floor(cap * 0.15), 1500) : 0;

      const compressed = compressToolOutput(
        toolName,
        result,
        config.sessionId,
        (sid, sourceId, tName, content) => kb.index(sid, sourceId, tName, content),
        snippetReserve,
      );

      if (compressed.indexed) {
        totalIndexed++;
        // Fix: Guard against negative savings — when under-cap content gets indexed AND a snippet is appended,
        // compressedSize can exceed originalSize (snippet adds bytes). Only credit positive savings.
        const delta = compressed.originalSize - compressed.compressedSize;
        if (delta > 0) totalSaved += delta;
      }

      // 5.1: Intent-driven filtering — append relevant snippet in the pre-reserved space
      // Runs AFTER compression (and outside the indexed check) so it can add content to under-cap results too
      if (snippetReserve > 0) {
        try {
          const query = recentKeywords.slice(-5).join(" ");
          const hits = config.channel ? kb.searchByChannel(query, config.channel, 1) : kb.search(query, undefined, 1);
          if (hits.length > 0 && hits[0].content.length > 0) {
            const headerLen = 46; // length of "\n\n[Relevant excerpt matching current context]\n"
            const snippetLen = Math.min(snippetReserve - headerLen - 150, 1500);
            if (snippetLen > 100) {
              const snippet = hits[0].content.slice(0, snippetLen);
              compressed.result.output += `\n\n[Relevant excerpt matching current context]\n${snippet}`;
              compressed.compressedSize = compressed.result.output.length;
            }
          }
        } catch {
          // Non-critical — intent filtering is best-effort
        }
      }

      // Track keywords from the original output for future intent matching
      if (result.output.length > 500) {
        updateRecentKeywords(result.output.slice(0, 2000));
      }

      return compressed;
    } catch (err) {
      // C26: graceful degradation — return uncompressed, ensure valid ToolResult
      const safeOutput = typeof result?.output === "string" ? result.output : "";
      return {
        result: { success: result?.success ?? false, output: safeOutput, error: result?.error },
        indexed: false,
        originalSize: safeOutput.length,
        compressedSize: safeOutput.length,
      };
    }
  }

  // ── knowledge_search tool handler ────────────────────────────

  function handleKnowledgeSearch(args: Record<string, any>): ToolResult {
    try {
      const query = args.query as string;
      if (!query) return { success: false, output: "", error: "query is required" };

      // Default to "channel" scope — agents only see knowledge from their own channel.
      // Use scope="global" to search across all channels.
      const scope = (args.scope as string) || "channel";
      const limit = Math.min(args.limit || 10, 50);

      const results =
        scope === "channel" && config.channel
          ? kb.searchByChannel(query, config.channel, limit)
          : kb.search(query, undefined, limit);

      if (results.length === 0) {
        return { success: true, output: "No results found for query: " + query };
      }

      const output = results
        .map((r, i) => {
          const header = `[${i + 1}] source: ${r.sourceId}, tool: ${r.toolName}, chunk: ${r.chunkIndex}`;
          const preview = r.content.length > 2000 ? r.content.slice(0, 2000) + "\n..." : r.content;
          return `${header}\n${preview}`;
        })
        .join("\n\n---\n\n");

      return { success: true, output };
    } catch (err) {
      return { success: false, output: "", error: `Search failed: ${err}` };
    }
  }

  // ── knowledge_stats tool handler ─────────────────────────────

  function handleKnowledgeStats(): ToolResult {
    try {
      const stats = kb.getStats(config.sessionId);
      const output = [
        `Knowledge Base Stats (session: ${config.sessionId})`,
        `  Entries: ${stats.entries}`,
        `  Total chars indexed: ${stats.totalChars.toLocaleString()}`,
        `  Unique sources: ${stats.sources}`,
        `  Total compressions: ${totalIndexed}`,
        `  Total chars saved: ${totalSaved.toLocaleString()}`,
      ].join("\n");
      return { success: true, output };
    } catch (err) {
      return { success: false, output: "", error: `Stats failed: ${err}` };
    }
  }

  // ── context_compact tool handler ─────────────────────────────

  async function handleContextCompact(_args: Record<string, any>): Promise<ToolResult> {
    try {
      if (!config.onCompactRequest) {
        return { success: false, output: "", error: "Compaction not available — onCompactRequest callback not set" };
      }
      const result = await config.onCompactRequest();
      const freed = result.before - result.after;
      const output = [
        `Context compacted:`,
        `  Before: ~${result.before} tokens`,
        `  After:  ~${result.after} tokens`,
        `  Freed:  ~${freed} tokens`,
      ].join("\n");
      return { success: true, output };
    } catch (err) {
      return { success: false, output: "", error: `Compaction failed: ${err}` };
    }
  }

  // ── Staleness detection ──────────────────────────────────────

  function handleStaleness(toolName: string, args: any): void {
    try {
      // File modification tools invalidate KB entries
      if (toolName === "edit" || toolName === "create") {
        const filePath = args?.file_path || args?.path;
        if (filePath) kb.invalidateSource(config.sessionId, filePath);
      }

      // Bash commands that modify files
      // Fix: Improved pattern catches sed (with/without -i), echo>/>>/|tee, mv/cp/rm, heredoc, python -c, node -e
      if (toolName === "bash" || toolName === "exec") {
        const cmd = args?.command || args?.cmd || "";
        const writePattern = /(?:^|\s)(?:mv|cp|rm|mkdir|tee)\s+|^[^#]*>|>>\s*|tee\s+[#\w]|sed\s+(?:[^|]|-[^i])/;
        const gitWritePattern = /git\s+(?:checkout|stash|reset|merge|add|commit|branch|restore)/;
        if (writePattern.test(cmd) || gitWritePattern.test(cmd)) {
          if (gitWritePattern.test(cmd)) {
            // Broad invalidation for git ops
            kb.invalidateSession(config.sessionId);
          } else {
            // Extract target file paths from the command
            // Match: file paths with extensions, paths after >, >>, |tee
            const paths: string[] = [
              ...(cmd.match(/[\w/.~-]+\.\w+/g) || []),
              ...(cmd.match(/(?<=>>?\s*)[^\s|]+/g) || []),
            ];
            for (const p of [...new Set(paths)]) {
              try {
                kb.invalidateSource(config.sessionId, p);
              } catch {
                // Non-critical
              }
            }
          }
        }
      }
    } catch {
      // Non-critical
    }
  }

  // ── Plugin (lifecycle hooks) ─────────────────────────────────

  const pluginHooks: PluginHooks = {
    onToolCall: async (name: string, args: any) => {
      handleStaleness(name, args);
      // 5.1: Track keywords from tool arguments for intent filtering
      try {
        const argsStr = typeof args === "string" ? args : JSON.stringify(args || {});
        if (argsStr.length > 10) updateRecentKeywords(argsStr);
      } catch {}
    },
    getSystemContext: async (_ctx) => {
      const stats = kb.getStats(config.sessionId);
      if (stats.entries === 0) return null;
      return `[Knowledge Base: ${stats.entries} chunks from ${stats.sources} sources indexed. Use knowledge_search(query) to retrieve.]`;
    },
    onShutdown: async () => {
      try {
        kb.optimize();
      } catch {}
    },
  };

  const plugin: Plugin = {
    name: "context-mode",
    version: "1.0.0",
    description: "FTS5 knowledge base and tool output compression",
    hooks: pluginHooks,
  };

  // ── ToolPlugin (tools registration) ──────────────────────────

  const toolPlugin: ToolPlugin = {
    name: "context-mode",
    getTools(): ToolRegistration[] {
      return [
        {
          name: "knowledge_search",
          description:
            "Search indexed tool outputs from this channel. Use when you see [Indexed] markers or need to retrieve previously truncated content.",
          parameters: {
            query: { type: "string", description: "Search query (keywords or phrases)" },
            scope: {
              type: "string",
              description: 'Search scope: "channel" (this channel only, default) or "global" (all channels)',
              enum: ["channel", "global"],
              default: "channel",
            },
            limit: {
              type: "number",
              description: "Max results (default: 10, max: 50)",
              default: 10,
            },
          },
          required: ["query"],
          handler: async (args) => handleKnowledgeSearch(args),
        },
        {
          name: "knowledge_stats",
          description: "Show knowledge base statistics: entries, sources, compression savings.",
          parameters: {},
          required: [],
          handler: async () => handleKnowledgeStats(),
        },
        {
          name: "context_compact",
          description: "Manually trigger context compaction to free tokens. Use when context is running low.",
          parameters: {},
          required: [],
          handler: async (args) => handleContextCompact(args),
        },
      ];
    },
    async destroy() {
      kb.destroy();
    },
  };

  return {
    plugin,
    toolPlugin,
    compressToolResult,
    destroy: () => kb.destroy(),
  };
}
