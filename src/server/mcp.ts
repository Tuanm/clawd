/**
 * MCP (Model Context Protocol) Handler for Chat Server
 *
 * Barrel module — re-exports from submodules under ./mcp/.
 * Contains only the main handleMcpRequest entry point.
 */

// Re-export handlers (used by index.ts route dispatch)
export { handleAgentMcpRequest } from "./mcp/agent-handler";
// Re-export shared state & setters (used by index.ts, scheduler, spaces)
export {
  setMcpScheduler,
  setMcpWorkerManager,
  spaceAuthTokens,
  spaceCompleteCallbacks,
  spaceProjectRoots,
  spaceTimeoutTimers,
} from "./mcp/shared";
export { handleSpaceMcpRequest } from "./mcp/space-handler";

// Submodule imports for this file's handleMcpRequest
import { executeToolCall } from "./mcp/execute";
import { jsonRpcError } from "./mcp/protocol";
import { MCP_TOOLS } from "./mcp/tool-defs";

/**
 * Handle MCP requests for the main chat server endpoint.
 * Route: /mcp
 */
export async function handleMcpRequest(req: Request): Promise<Response> {
  const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };

  // Handle CORS preflight
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405,
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

    const { jsonrpc, id, method, params = {} } = body;

    if (jsonrpc !== "2.0") {
      return jsonRpcError(id, -32600, "Invalid JSON-RPC version", corsHeaders);
    }

    let result: unknown;

    switch (method) {
      // MCP Protocol methods
      case "initialize":
        result = {
          protocolVersion: "2024-11-05",
          serverInfo: {
            name: "chat-mcp-server",
            version: "1.0.0",
          },
          capabilities: {
            tools: {},
          },
        };
        break;

      case "tools/list": {
        const scope = new URL(req.url, "http://localhost").searchParams.get("scope");
        const tools = scope === "space" ? MCP_TOOLS.filter((t: any) => t.name.startsWith("chat_")) : MCP_TOOLS;
        result = { tools };
        break;
      }

      case "tools/call": {
        const scope = new URL(req.url, "http://localhost").searchParams.get("scope");
        const { name, arguments: args } = params as {
          name: string;
          arguments: Record<string, unknown>;
        };
        if (scope === "space" && !name.startsWith("chat_")) {
          result = {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  ok: false,
                  error: "Tool not available in space scope",
                }),
              },
            ],
          };
          break;
        }
        result = await executeToolCall(name, args || {});
        break;
      }

      default:
        return jsonRpcError(id, -32601, `Method not found: ${method}`, corsHeaders);
    }

    return new Response(
      JSON.stringify({
        jsonrpc: "2.0",
        id,
        result,
      }),
      {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      },
    );
  } catch (error) {
    console.error("[MCP] Error:", error);
    return new Response(
      JSON.stringify({
        jsonrpc: "2.0",
        id: null,
        error: {
          code: -32603,
          message: error instanceof Error ? error.message : "Internal error",
        },
      }),
      {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      },
    );
  }
}
