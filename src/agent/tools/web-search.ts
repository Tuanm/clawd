/**
 * Web Search — Provider-specific backends
 *
 * - Copilot: calls GitHub MCP server's web_search tool directly
 * - Others: falls back to DuckDuckGo HTML search
 */

import { getContextProvider } from "../utils/agent-context";

interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

interface SearchResponse {
  results: SearchResult[];
  error?: string;
}

// ============================================================================
// Copilot: GitHub MCP Server web_search
// ============================================================================

async function searchViaCopilot(query: string, maxResults: number): Promise<SearchResponse> {
  // Get Copilot token
  const { getCopilotToken } = await import("../api/provider-config");
  const token = getCopilotToken();
  if (!token) {
    return { results: [], error: "No Copilot token available" };
  }

  const mcpUrl = "https://api.githubcopilot.com/mcp/readonly";
  const requestId = Date.now();

  // JSON-RPC call to MCP tools/call
  const body = JSON.stringify({
    jsonrpc: "2.0",
    id: requestId,
    method: "tools/call",
    params: {
      name: "web_search",
      arguments: { query, count: maxResults },
    },
  });

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 20_000);

  try {
    const res = await fetch(mcpUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        "X-MCP-Toolsets": "web_search",
        "X-MCP-Tools": "web_search",
        "X-MCP-Host": "github-coding-agent",
        "X-Initiator": "agent",
        "Copilot-Integration-Id": "copilot-developer-cli",
      },
      body,
      signal: ctrl.signal,
    });

    if (!res.ok) {
      return { results: [], error: `GitHub MCP server returned ${res.status}` };
    }

    // Response may be SSE or direct JSON
    const contentType = res.headers.get("content-type") || "";
    let responseData: any;

    if (contentType.includes("text/event-stream")) {
      // Parse SSE to extract JSON-RPC response
      const text = await res.text();
      const lines = text.split("\n");
      for (const line of lines) {
        if (line.startsWith("data: ")) {
          try {
            const parsed = JSON.parse(line.slice(6));
            if (parsed.id === requestId || parsed.result) {
              responseData = parsed;
              break;
            }
          } catch {}
        }
      }
    } else {
      responseData = await res.json();
    }

    if (!responseData?.result) {
      return { results: [], error: "No result from GitHub MCP server" };
    }

    // Extract search results from MCP response
    // MCP tools/call returns { content: [{ type: "text", text: "..." }] }
    const content = responseData.result.content;
    if (!Array.isArray(content)) {
      return { results: [], error: "Unexpected MCP response format" };
    }

    const results: SearchResult[] = [];
    for (const item of content) {
      if (item.type === "text" && item.text) {
        try {
          // Try parsing as JSON (structured results)
          const parsed = JSON.parse(item.text);
          if (Array.isArray(parsed)) {
            for (const r of parsed) {
              if (r.title && r.url) {
                results.push({ title: r.title, url: r.url, snippet: r.snippet || r.description || "" });
              }
            }
          } else if (parsed.results && Array.isArray(parsed.results)) {
            for (const r of parsed.results) {
              if (r.title && r.url) {
                results.push({ title: r.title, url: r.url, snippet: r.snippet || r.description || "" });
              }
            }
          }
        } catch {
          // Plain text result — parse as markdown-style results
          const lines = item.text.split("\n");
          let current: Partial<SearchResult> = {};
          for (const line of lines) {
            const urlMatch = line.match(/https?:\/\/[^\s)]+/);
            const titleMatch = line.match(/\[([^\]]+)\]/);
            if (titleMatch) current.title = titleMatch[1];
            if (urlMatch) current.url = urlMatch[0];
            if (current.title && current.url) {
              results.push({ title: current.title, url: current.url, snippet: current.snippet || "" });
              current = {};
            }
            if (!current.title && !urlMatch && line.trim()) {
              current.snippet = (current.snippet ? current.snippet + " " : "") + line.trim();
            }
          }
        }
      }
    }

    return { results: results.slice(0, maxResults) };
  } finally {
    clearTimeout(timer);
  }
}

// ============================================================================
// DuckDuckGo: Fallback for all providers
// ============================================================================

async function searchViaDuckDuckGo(query: string, maxResults: number): Promise<SearchResponse> {
  const searchUrl = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15_000);

  try {
    const response = await fetch(searchUrl, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        Accept: "text/html",
      },
      signal: ctrl.signal,
    });

    if (!response.ok) {
      return { results: [], error: `DuckDuckGo returned HTTP ${response.status}` };
    }

    const html = await response.text();
    const results: SearchResult[] = [];

    // Parse result blocks
    const resultRegex =
      /<a[^>]*class="result__a"[^>]*href="([^"]*)"[^>]*>([^<]*)<\/a>[\s\S]*?<a[^>]*class="result__snippet"[^>]*>([^<]*)/g;

    let match;
    while ((match = resultRegex.exec(html)) !== null && results.length < maxResults) {
      const [, url, title, snippet] = match;
      if (url && title) {
        results.push({
          title: title.trim(),
          url: url.startsWith("//") ? `https:${url}` : url,
          snippet: snippet?.trim() || "",
        });
      }
    }

    // Fallback parsing
    if (results.length === 0) {
      const altRegex = /<a[^>]*rel="nofollow"[^>]*href="([^"]*)"[^>]*>([^<]*)<\/a>/g;
      while ((match = altRegex.exec(html)) !== null && results.length < maxResults) {
        const [, url, title] = match;
        if (url && title && url.startsWith("http") && !url.includes("duckduckgo.com")) {
          results.push({ title: title.trim(), url, snippet: "" });
        }
      }
    }

    return { results };
  } finally {
    clearTimeout(timer);
  }
}

// ============================================================================
// Public API
// ============================================================================

export async function webSearch(query: string, maxResults: number = 5): Promise<SearchResponse> {
  const provider = getContextProvider();

  // Copilot: use GitHub MCP server's web_search
  if (provider === "copilot") {
    const result = await searchViaCopilot(query, maxResults);
    // Fall back to DuckDuckGo if Copilot search fails
    if (result.results.length > 0) return result;
    console.log(`[web_search] Copilot search returned 0 results, falling back to DuckDuckGo`);
  }

  // Fallback: DuckDuckGo
  return searchViaDuckDuckGo(query, maxResults);
}
