/**
 * MCP Protocol helpers — JSON-RPC error construction, CORS headers, and shared utilities.
 */

/** CORS headers for standard MCP endpoints */
export const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

/** CORS headers for space MCP endpoints (also allow Authorization header) */
export const CORS_HEADERS_WITH_AUTH = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

/** Build a JSON-RPC 2.0 error response */
export function jsonRpcError(
  id: number | string | null,
  code: number,
  message: string,
  headers: Record<string, string>,
): Response {
  return new Response(
    JSON.stringify({
      jsonrpc: "2.0",
      id,
      error: { code, message },
    }),
    {
      headers: { ...headers, "Content-Type": "application/json" },
    },
  );
}

/**
 * Truncate text for agent context — always active (defense in depth).
 * Applied unconditionally regardless of contextMode since this prevents
 * the agent from re-ingesting untruncated content via MCP retrieval tools.
 */
export function truncateForAgent(text: string | undefined | null, maxLength = 10000): string {
  if (!text || text.length <= maxLength) return text || "";
  const marker = "\n\n[TRUNCATED — content too long for agent context]";
  let cp = maxLength - marker.length;
  if (cp > 0 && cp < text.length && text.charCodeAt(cp - 1) >= 0xd800 && text.charCodeAt(cp - 1) <= 0xdbff) cp--;
  return text.slice(0, cp) + marker;
}
