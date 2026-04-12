/**
 * MCP handler for space-scoped requests.
 * Only exposes complete_task + file tools + web tools.
 * Route: /mcp/space/{spaceId}
 */

import { spaceAuthTokens, spaceCompleteCallbacks, spaceProjectRoots } from "./shared";

export async function handleSpaceMcpRequest(req: Request, spaceId: string): Promise<Response> {
  const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
  };

  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  // Validate per-space auth token
  const authHeader = req.headers.get("Authorization") || "";
  const reqToken = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
  const expectedToken = spaceAuthTokens.get(spaceId);
  if (!expectedToken || reqToken !== expectedToken) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  try {
    const body = (await req.json()) as {
      jsonrpc: string;
      id: number | string;
      method: string;
      params?: Record<string, unknown>;
    };
    const { id, method, params = {} } = body;

    let result: unknown;

    switch (method) {
      case "initialize":
        result = {
          protocolVersion: "2024-11-05",
          serverInfo: { name: "clawd-space-mcp", version: "1.0.0" },
          capabilities: { tools: {} },
        };
        break;

      case "notifications/initialized":
        // Client acknowledgment — no response needed for notifications
        return new Response(null, { status: 204, headers: corsHeaders });

      case "tools/list": {
        const { getMcpFileToolDefs: getSpaceFileToolDefs } = await import("../mcp-file-tools");
        const spaceFileToolDefs = getSpaceFileToolDefs().map((t) => ({
          name: t.name,
          description: t.description,
          inputSchema: t.inputSchema,
        }));
        const { CUSTOM_SCRIPT_MCP_TOOL_DEF: spaceCustomScriptToolDef } = await import(
          "../../agent/plugins/custom-tool-plugin"
        );
        result = {
          tools: [
            {
              name: "complete_task",
              description:
                "Signal that your task is fully complete. Call this ONCE when done. " +
                "This posts your result to the parent channel and closes the sub-space.",
              inputSchema: {
                type: "object",
                properties: {
                  space_id: { type: "string", description: "The space ID (from your system prompt)" },
                  result: { type: "string", description: "Your final result summary" },
                },
                required: ["space_id", "result"],
              },
            },
            ...spaceFileToolDefs,
            spaceCustomScriptToolDef,
            {
              name: "web_search",
              description: "Search the web. Returns results with titles, URLs, and snippets.",
              inputSchema: {
                type: "object",
                properties: {
                  query: { type: "string", description: "The search query" },
                  max_results: { type: "number", description: "Maximum number of results (default: 5)" },
                  allowed_domains: {
                    type: "array",
                    items: { type: "string" },
                    description: "Only include results from these domains",
                  },
                  blocked_domains: {
                    type: "array",
                    items: { type: "string" },
                    description: "Exclude results from these domains",
                  },
                },
                required: ["query"],
              },
            },
            {
              name: "web_fetch",
              description: "Fetch a URL and return its content as markdown.",
              inputSchema: {
                type: "object",
                properties: {
                  url: { type: "string", description: "The URL to fetch" },
                  raw: { type: "boolean", description: "Return raw HTML instead of markdown (default: false)" },
                  max_length: { type: "number", description: "Maximum characters to return (default: 10000)" },
                },
                required: ["url"],
              },
            },
          ],
        };
        break;
      }

      case "tools/call": {
        const { name, arguments: toolArgs } = params as {
          name: string;
          arguments: Record<string, unknown>;
        };

        if (name.startsWith("file_")) {
          try {
            const projectRoot = spaceProjectRoots.get(spaceId);
            if (!projectRoot) {
              return new Response(
                JSON.stringify({
                  jsonrpc: "2.0",
                  id,
                  result: {
                    content: [
                      {
                        type: "text",
                        text: JSON.stringify({
                          ok: false,
                          error: "Space project root not registered yet — the space may still be initializing",
                        }),
                      },
                    ],
                  },
                }),
                { headers: { ...corsHeaders, "Content-Type": "application/json" } },
              );
            }
            const { executeMcpFileTool } = await import("../mcp-file-tools");
            const fileResult = await executeMcpFileTool(name, (toolArgs || {}) as Record<string, unknown>, projectRoot);
            return new Response(JSON.stringify({ jsonrpc: "2.0", id, result: fileResult }), {
              headers: { ...corsHeaders, "Content-Type": "application/json" },
            });
          } catch (err: unknown) {
            return new Response(
              JSON.stringify({
                jsonrpc: "2.0",
                id,
                result: {
                  content: [
                    {
                      type: "text",
                      text: JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) }),
                    },
                  ],
                },
              }),
              { headers: { ...corsHeaders, "Content-Type": "application/json" } },
            );
          }
        }

        if (name === "custom_script") {
          try {
            const projectRoot = spaceProjectRoots.get(spaceId);
            if (!projectRoot) {
              return new Response(
                JSON.stringify({
                  jsonrpc: "2.0",
                  id,
                  result: {
                    content: [
                      {
                        type: "text",
                        text: JSON.stringify({
                          ok: false,
                          error: "Space project root not registered yet — the space may still be initializing",
                        }),
                      },
                    ],
                  },
                }),
                { headers: { ...corsHeaders, "Content-Type": "application/json" } },
              );
            }
            const { executeCustomScriptMcp } = await import("../../agent/plugins/custom-tool-plugin");
            const customScriptResult = await executeCustomScriptMcp(
              projectRoot,
              (toolArgs || {}) as Record<string, any>,
            );
            return new Response(JSON.stringify({ jsonrpc: "2.0", id, result: customScriptResult }), {
              headers: { ...corsHeaders, "Content-Type": "application/json" },
            });
          } catch (err: unknown) {
            return new Response(
              JSON.stringify({
                jsonrpc: "2.0",
                id,
                result: {
                  content: [
                    {
                      type: "text",
                      text: JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) }),
                    },
                  ],
                },
              }),
              { headers: { ...corsHeaders, "Content-Type": "application/json" } },
            );
          }
        }

        if (name === "web_search" || name === "web_fetch") {
          try {
            if (name === "web_search") {
              const { webSearch } = await import("../../agent/tools/web-search");
              const query = (toolArgs?.query as string) || "";
              const maxResults = (toolArgs?.max_results as number) || 5;
              const allowedDomains = toolArgs?.allowed_domains as string[] | undefined;
              const blockedDomains = toolArgs?.blocked_domains as string[] | undefined;
              if (!query) {
                result = {
                  content: [
                    { type: "text", text: JSON.stringify({ ok: false, error: "Missing required parameter: query" }) },
                  ],
                };
                break;
              }
              let q = query;
              if (Array.isArray(allowedDomains) && allowedDomains.length > 0)
                q += " " + allowedDomains.map((d) => `site:${d}`).join(" OR ");
              const sr = await webSearch(q, maxResults);
              const filtered =
                Array.isArray(blockedDomains) && blockedDomains.length > 0
                  ? {
                      ...sr,
                      results: (sr as any).results?.filter(
                        (r: any) => !blockedDomains.some((d: string) => r.url?.includes(d)),
                      ),
                    }
                  : sr;
              result = { content: [{ type: "text", text: JSON.stringify(filtered) }] };
            } else {
              const url = (toolArgs?.url as string) || "";
              const raw = (toolArgs?.raw as boolean) || false;
              const maxLength = (toolArgs?.max_length as number) || 10000;
              if (!url) {
                result = {
                  content: [
                    { type: "text", text: JSON.stringify({ ok: false, error: "Missing required parameter: url" }) },
                  ],
                };
                break;
              }
              const ctrl = new AbortController();
              const timer = setTimeout(() => ctrl.abort(), 30000);
              const fetchRes = await fetch(url, {
                headers: {
                  "User-Agent": "Mozilla/5.0 (compatible; ClawdAgent/1.0)",
                  Accept: "text/html,application/json,text/plain,*/*",
                },
                signal: ctrl.signal,
              }).finally(() => clearTimeout(timer));
              if (!fetchRes.ok) {
                result = {
                  content: [
                    {
                      type: "text",
                      text: JSON.stringify({ ok: false, error: `HTTP ${fetchRes.status}: ${fetchRes.statusText}` }),
                    },
                  ],
                };
                break;
              }
              const contentType = fetchRes.headers.get("content-type") || "";
              let content = await fetchRes.text();
              const { stripHtmlTagBlocks } = await import("../../agent/tools/registry");
              if (!raw && contentType.includes("text/html")) {
                content = stripHtmlTagBlocks(content, "script");
                content = stripHtmlTagBlocks(content, "style");
                content = content
                  .replace(/<p[^>]*>/gi, "\n")
                  .replace(/<\/p>/gi, "\n")
                  .replace(/<br\s*\/?>/gi, "\n")
                  .replace(/<li[^>]*>/gi, "- ")
                  .replace(/<\/li>/gi, "\n")
                  .replace(/<[^>]+>/g, "")
                  .replace(/&nbsp;/g, " ")
                  .replace(/&lt;/g, "<")
                  .replace(/&gt;/g, ">")
                  .replace(/&quot;/g, '"')
                  .replace(/&amp;/g, "&")
                  .replace(/\n{3,}/g, "\n\n")
                  .trim();
              }
              if (content.length > maxLength) content = content.substring(0, maxLength) + "\n\n[Content truncated]";
              result = { content: [{ type: "text", text: JSON.stringify({ ok: true, content }) }] };
            }
          } catch (webErr: unknown) {
            result = {
              content: [
                {
                  type: "text",
                  text: JSON.stringify({ ok: false, error: webErr instanceof Error ? webErr.message : String(webErr) }),
                },
              ],
            };
          }
          break;
        }

        if (name !== "complete_task") {
          result = { content: [{ type: "text", text: JSON.stringify({ ok: false, error: "Unknown tool" }) }] };
          break;
        }

        const argSpaceId = toolArgs?.space_id as string;
        const taskResult = toolArgs?.result as string;

        if (argSpaceId !== spaceId) {
          result = { content: [{ type: "text", text: JSON.stringify({ ok: false, error: "Invalid space_id" }) }] };
          break;
        }

        // Fire the completion callback
        const callback = spaceCompleteCallbacks.get(spaceId);
        if (callback) {
          callback(taskResult || "Task completed");
        }

        result = { content: [{ type: "text", text: JSON.stringify({ ok: true, message: "Task completed." }) }] };
        break;
      }

      default:
        result = {
          content: [{ type: "text", text: JSON.stringify({ ok: false, error: `Unknown method: ${method}` }) }],
        };
    }

    return new Response(JSON.stringify({ jsonrpc: "2.0", id, result }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error) {
    return new Response(
      JSON.stringify({
        jsonrpc: "2.0",
        id: null,
        error: { code: -32603, message: error instanceof Error ? error.message : "Internal error" },
      }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
}
