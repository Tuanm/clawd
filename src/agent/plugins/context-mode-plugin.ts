/**
 * Context Mode Plugin — FTS5 knowledge base + tool output compression
 * Phase 3.2: Factory function returning { plugin, toolPlugin, compressToolResult }
 *
 * The compressToolResult method is called directly from agent.ts executeSingleToolCall,
 * NOT via afterExecute (to avoid double-compression).
 */

import { KnowledgeBase } from "../memory/knowledge-base";
import type { ToolContext, ToolPlugin, ToolRegistration } from "../tools/plugin";
import type { ToolResult } from "../tools/tools";
import { type CompressResult, compressToolOutput, getToolCap } from "../utils/output-compressor";
import type { Plugin, PluginHooks } from "./manager";

// ── Keyword Stop Words (module-level for single compilation) ───────

const STOP_WORDS =
  /^(this|that|with|from|have|been|will|were|they|then|than|also|just|more|some|only|very|each|when|what|into|function|return|const|async|await|class|export|import|string|number|boolean|object|array|error|undefined|null|true|false|void|typeof|interface|method|module|require|default|super|yield|static|extends|implements|throw|catch|finally|break|continue|switch|case|while|else|type|enum|value|result|index|length|push|slice|data|args|name|path|file|line|code|test|spec|console|stdout|stderr|process|buffer|callback|promise|resolve|reject)$/;

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
    // Simple TF extraction: split on non-word, keep 4+ char tokens, dedupe
    const words = text
      .toLowerCase()
      .split(/\W+/)
      .filter(
        (w) =>
          w.length >= 4 &&
          !STOP_WORDS.test(w) &&
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

      const compressed = compressToolOutput(toolName, result, config.sessionId, (sid, sourceId, tName, content) =>
        kb.index(sid, sourceId, tName, content),
      );

      if (compressed.indexed) {
        totalIndexed++;
        totalSaved += compressed.originalSize - compressed.compressedSize;

        // 5.1: Intent-driven filtering — append relevant snippet within per-tool cap budget
        if (recentKeywords.length > 0) {
          try {
            const cap = getToolCap(toolName);
            const availableSpace = cap - compressed.result.output.length;
            if (availableSpace > 200) {
              // minimum useful snippet size
              const query = recentKeywords.slice(-5).join(" ");
              const hits = config.channel
                ? kb.searchByChannel(query, config.channel, 1)
                : kb.search(query, undefined, 1);
              if (hits.length > 0 && hits[0].content.length > 0) {
                const headerLen = 46; // length of "\n\n[Relevant excerpt matching current context]\n"
                const snippetLen = Math.min(availableSpace - headerLen, 1500);
                if (snippetLen > 100) {
                  const snippet = hits[0].content.slice(0, snippetLen);
                  compressed.result.output += `\n\n[Relevant excerpt matching current context]\n${snippet}`;
                  compressed.compressedSize = compressed.result.output.length;
                }
              }
            }
          } catch {
            // Non-critical — intent filtering is best-effort
          }
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
      if (toolName === "bash" || toolName === "exec") {
        const cmd = args?.command || args?.cmd || "";
        const fileModPattern = /(mv|cp|rm|sed\s+-i|git\s+(checkout|stash|reset|merge))\s+/;
        if (fileModPattern.test(cmd)) {
          if (/git\s+(checkout|stash|reset|merge)/.test(cmd)) {
            // Broad invalidation for git ops
            kb.invalidateSession(config.sessionId);
          } else {
            // Extract target file paths
            const paths = cmd.match(/[\w/.~-]+\.\w+/g);
            if (paths) {
              for (const p of paths) kb.invalidateSource(config.sessionId, p);
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
