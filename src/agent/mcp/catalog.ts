/**
 * MCP Built-in Server Catalog
 *
 * Pre-configured popular MCP server entries for one-click installation.
 * Drives the "Browse" tab in McpDialog and auto-provision from agent files.
 */

export interface MCPCatalogEntry {
  id: string;
  name: string;
  description: string;
  logo?: string; // SVG inline or URL; falls back to McpIcon in UI
  transport: "stdio" | "http";
  // stdio
  command?: string;
  args?: string[]; // may contain {TEMPLATE_VARS}
  envRequired?: string[]; // shown as required form fields in UI
  envOptional?: string[];
  installHint?: string; // shown below install form
  // http
  url?: string;
  requiresOAuth?: boolean; // if true, UI shows two-step OAuth install flow
  // metadata
  category: "dev" | "data" | "comms" | "web" | "other";
  official: boolean;
  popularity: number; // 1–5, for sort order
  docsUrl?: string;
}

/**
 * Resolve template variables in an args array.
 * Throws if any referenced variable is not provided.
 */
export function resolveArgs(args: string[], vars: Record<string, string>): string[] {
  return args.map((a) =>
    a.replace(/\{\{(\w+)\}\}|\{(\w+)\}/g, (_, d, s) => {
      const k = d || s!;
      if (vars[k] === undefined || vars[k] === "") {
        throw new Error(`Catalog template variable {${k}} not provided`);
      }
      return vars[k];
    }),
  );
}

export const MCP_CATALOG: MCPCatalogEntry[] = [
  {
    id: "github",
    name: "GitHub",
    description: "Search repositories, manage issues, pull requests, and files via the GitHub API.",
    transport: "stdio",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-github"],
    envRequired: ["GITHUB_TOKEN"],
    category: "dev",
    official: true,
    popularity: 5,
    docsUrl: "https://github.com/modelcontextprotocol/servers/tree/main/src/github",
  },
  {
    id: "filesystem",
    name: "Filesystem",
    description: "Read and write files within a specified local directory.",
    transport: "stdio",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-filesystem", "{PROJECT_ROOT}"],
    category: "dev",
    official: true,
    popularity: 5,
    docsUrl: "https://github.com/modelcontextprotocol/servers/tree/main/src/filesystem",
  },
  {
    id: "postgres",
    name: "PostgreSQL",
    description: "Query and inspect a PostgreSQL database via a connection URL.",
    transport: "stdio",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-postgres", "{DATABASE_URL}"],
    envRequired: ["DATABASE_URL"],
    category: "data",
    official: true,
    popularity: 4,
    docsUrl: "https://github.com/anthropics/anthropic-cookbook/tree/main/mcp",
  },
  {
    id: "sentry",
    name: "Sentry",
    description: "Access Sentry error reports, issues, events, and project data.",
    transport: "http",
    url: "https://mcp.sentry.dev/mcp",
    requiresOAuth: true,
    category: "dev",
    official: true,
    popularity: 3,
    docsUrl: "https://docs.sentry.io/product/sentry-mcp/",
  },
  {
    id: "notion",
    name: "Notion",
    description: "Read and write Notion pages, databases, and workspace content.",
    transport: "http",
    url: "https://mcp.notion.com/mcp",
    requiresOAuth: true,
    category: "other",
    official: true,
    popularity: 4,
    docsUrl: "https://developers.notion.com/docs/mcp",
  },
  {
    id: "slack",
    name: "Slack",
    description: "Send messages, search channels, and read conversations in Slack.",
    transport: "stdio",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-slack"],
    envRequired: ["SLACK_BOT_TOKEN", "SLACK_TEAM_ID"],
    category: "comms",
    official: true,
    popularity: 4,
    docsUrl: "https://github.com/anthropics/anthropic-cookbook/tree/main/mcp",
  },
  {
    id: "fetch",
    name: "Web Fetch",
    description: "Fetch and extract readable content from web pages.",
    transport: "stdio",
    command: "uvx",
    args: ["mcp-server-fetch"],
    installHint: "Requires uv — install from https://docs.astral.sh/uv/",
    category: "web",
    official: true,
    popularity: 4,
    docsUrl: "https://github.com/modelcontextprotocol/servers/tree/main/src/fetch",
  },
  {
    id: "puppeteer",
    name: "Puppeteer",
    description: "Browser automation: navigate pages, take screenshots, interact with forms.",
    transport: "stdio",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-puppeteer"],
    category: "web",
    official: true,
    popularity: 3,
    docsUrl: "https://github.com/anthropics/anthropic-cookbook/tree/main/mcp",
  },
  {
    id: "atlassian",
    name: "Atlassian",
    description: "Access Jira issues, Confluence pages, and Atlassian workspace data via OAuth.",
    transport: "http",
    url: "https://mcp.atlassian.com/v1/mcp",
    requiresOAuth: true,
    category: "dev",
    official: true,
    popularity: 3,
    docsUrl: "https://developer.atlassian.com/platform/mcp/",
  },
  {
    id: "lsp-typescript",
    name: "LSP: TypeScript / JavaScript",
    description:
      "Language Server Protocol for TypeScript and JavaScript: type-checking diagnostics, go-to-definition, find references, hover types, and symbol search. Shared across all agents in the channel. Requires vtsls.",
    transport: "stdio",
    command: "mcp-language-server",
    args: ["--workspace", "{PROJECT_ROOT}", "--lsp", "vtsls", "--", "--stdio"],
    installHint:
      "Pre-installed in Docker. For local use: go install github.com/isaacphi/mcp-language-server@latest && npm install -g @vtsls/language-server typescript",
    category: "dev",
    official: false,
    popularity: 4,
    docsUrl: "https://github.com/isaacphi/mcp-language-server",
  },
  {
    id: "lsp-python",
    name: "LSP: Python",
    description:
      "Language Server Protocol for Python: type diagnostics, go-to-definition, find references, hover types, and symbol search. Shared across all agents in the channel. Requires pyright.",
    transport: "stdio",
    command: "mcp-language-server",
    args: ["--workspace", "{PROJECT_ROOT}", "--lsp", "pyright-langserver", "--", "--stdio"],
    installHint:
      "Pre-installed in Docker. For local use: go install github.com/isaacphi/mcp-language-server@latest && pip install pyright",
    category: "dev",
    official: false,
    popularity: 3,
    docsUrl: "https://github.com/isaacphi/mcp-language-server",
  },
  {
    id: "lsp-go",
    name: "LSP: Go",
    description:
      "Language Server Protocol for Go: type diagnostics, go-to-definition, find references, hover types, and symbol search. Shared across all agents in the channel. Requires gopls.",
    transport: "stdio",
    command: "mcp-language-server",
    args: ["--workspace", "{PROJECT_ROOT}", "--lsp", "gopls"],
    installHint:
      "Pre-installed in Docker. For local use: go install github.com/isaacphi/mcp-language-server@latest && go install golang.org/x/tools/gopls@latest",
    category: "dev",
    official: false,
    popularity: 3,
    docsUrl: "https://github.com/isaacphi/mcp-language-server",
  },
];

/** Look up a single catalog entry by ID. */
export function getCatalogEntry(id: string): MCPCatalogEntry | undefined {
  return MCP_CATALOG.find((e) => e.id === id);
}

/**
 * Search / filter catalog entries.
 * Results sorted by popularity descending.
 */
export function searchCatalog(query?: string, category?: string): MCPCatalogEntry[] {
  let results = [...MCP_CATALOG];
  if (category) {
    results = results.filter((e) => e.category === category);
  }
  if (query) {
    const q = query.toLowerCase();
    results = results.filter(
      (e) =>
        e.id.toLowerCase().includes(q) || e.name.toLowerCase().includes(q) || e.description.toLowerCase().includes(q),
    );
  }
  return results.sort((a, b) => b.popularity - a.popularity);
}

/** Return the distinct categories present in the catalog. */
export function listCategories(): string[] {
  return [...new Set(MCP_CATALOG.map((e) => e.category))];
}
