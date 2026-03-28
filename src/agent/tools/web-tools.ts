/**
 * Web Tools — web_fetch, web_search
 *
 * Registers web fetch and search tools into the shared tool registry.
 */

import { registerTool, stripHtmlTagBlocks } from "./registry";

// ============================================================================
// Tool: Web Fetch
// ============================================================================

registerTool(
  "web_fetch",
  "Fetch a URL from the internet and return the content. Supports HTML pages (converted to markdown), JSON APIs, and text content.",
  {
    url: {
      type: "string",
      description: "The URL to fetch",
    },
    raw: {
      type: "boolean",
      description: "If true, returns raw HTML instead of converting to markdown (default: false)",
    },
    max_length: {
      type: "number",
      description: "Maximum number of characters to return (default: 10000)",
    },
  },
  ["url"],
  async (args) => {
    const { url, raw = false, max_length = 10000 } = args;

    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 30000);
      const response = await fetch(url, {
        headers: {
          "User-Agent": "Mozilla/5.0 (compatible; ClawdAgent/1.0)",
          Accept: "text/html,application/json,text/plain,*/*",
        },
        signal: ctrl.signal,
      }).finally(() => clearTimeout(timer));

      if (!response.ok) {
        return {
          success: false,
          output: "",
          error: `HTTP ${response.status}: ${response.statusText}`,
        };
      }

      const contentType = response.headers.get("content-type") || "";
      let content = await response.text();

      // For HTML, do basic conversion to markdown unless raw=true
      if (!raw && contentType.includes("text/html")) {
        // Basic HTML to text conversion — strip unsafe tags via index-based search (CodeQL-safe)
        content = stripHtmlTagBlocks(content, "script");
        content = stripHtmlTagBlocks(content, "style");
        content = content // lgtm[js/incomplete-multi-character-sanitization]
          // Convert paragraphs and breaks
          .replace(/<p[^>]*>/gi, "\n")
          .replace(/<\/p>/gi, "\n")
          .replace(/<br\s*\/?>/gi, "\n")
          // Convert lists
          .replace(/<li[^>]*>/gi, "- ")
          .replace(/<\/li>/gi, "\n")
          // Remove all remaining tags (strip only tag markup, not content)
          .replace(/<[^>]+>/g, "")
          // Decode HTML entities (single-pass ordering: &amp; last to avoid double-decode)
          .replace(/&nbsp;/g, " ")
          .replace(/&lt;/g, "<")
          .replace(/&gt;/g, ">")
          .replace(/&quot;/g, '"')
          .replace(/&amp;/g, "&")
          // Clean up whitespace
          .replace(/\n{3,}/g, "\n\n")
          .trim();
      }

      // Truncate if needed
      if (content.length > max_length) {
        content = `${content.substring(0, max_length)}\n\n[Content truncated - file too large. Use view() with start_line/end_line parameters to read specific sections, or use grep to find relevant parts first.]`;
      }

      return { success: true, output: content };
    } catch (err: any) {
      return { success: false, output: "", error: err.message };
    }
  },
);

// ============================================================================
// Tool: Web Search (DuckDuckGo)
// ============================================================================

registerTool(
  "web_search",
  "Search the web. Returns search results with titles, URLs, and snippets. Automatically uses the best search backend for the current provider.",
  {
    query: { type: "string", description: "The search query" },
    max_results: { type: "number", description: "Maximum number of results (default: 5)" },
    allowed_domains: {
      type: "array",
      description: "Only include results from these domains",
      items: { type: "string" },
    },
    blocked_domains: { type: "array", description: "Exclude results from these domains", items: { type: "string" } },
  },
  ["query"],
  async (args) => {
    const { query, max_results = 5, allowed_domains, blocked_domains } = args;
    try {
      const { webSearch } = await import("./web-search");
      // Append domain filters to query for DuckDuckGo (site: syntax)
      let effectiveQuery = query;
      if (Array.isArray(allowed_domains) && allowed_domains.length > 0) {
        effectiveQuery += " " + allowed_domains.map((d: string) => `site:${d}`).join(" OR ");
      }
      if (Array.isArray(blocked_domains) && blocked_domains.length > 0) {
        effectiveQuery += " " + blocked_domains.map((d: string) => `-site:${d}`).join(" ");
      }
      const result = await webSearch(effectiveQuery, max_results);

      if (result.error && result.results.length === 0) {
        return { success: false, output: "", error: result.error };
      }

      if (result.results.length === 0) {
        return { success: true, output: `No results found for: ${query}` };
      }

      const output = result.results
        .map((r, i) => `${i + 1}. **${r.title}**\n   ${r.url}\n   ${r.snippet}`)
        .join("\n\n");

      return { success: true, output: `Search results for "${query}":\n\n${output}` };
    } catch (err: any) {
      return { success: false, output: "", error: err.message };
    }
  },
);
