/**
 * Auth middleware helpers for the Claw'd HTTP server.
 *
 * Exports:
 *   extractToken()       — pull Bearer token from Authorization header
 *   extractWsToken()     — pull token from WebSocket upgrade query param
 *   isInternalToken()    — constant-time compare against the internal service token
 *   handleAuthChannel()  — /api/auth.channel probe endpoint (pre-auth, no token required)
 *   corsResponse         — cached OPTIONS pre-flight response
 */

import { timingSafeEqual } from "node:crypto";
import { INTERNAL_SERVICE_TOKEN } from "../internal-token";
import { hasGlobalAuth, isChannelAuthRequired, validateApiToken } from "../config/config-file";
import { corsHeaders, json, parseBody } from "./http-helpers";

/** Cached OPTIONS pre-flight response (CORS) */
export const corsResponse = new Response(null, { headers: corsHeaders });

/**
 * Extract token from Authorization header (Bearer or raw) or null.
 * IMPORTANT: Never log the raw Authorization header or returned token value.
 * If debug logging is added, redact it: header.replace(/\S+$/, "[REDACTED]")
 */
export function extractToken(req: Request): string | null {
  const authHeader = req.headers.get("authorization");
  if (!authHeader) return null;
  // Case-insensitive "Bearer " prefix (HTTP spec allows any case)
  if (authHeader.toLowerCase().startsWith("bearer ")) return authHeader.slice(7);
  return authHeader; // raw token
}

/**
 * Extract token from query param — only for WebSocket upgrades.
 * IMPORTANT: Never log url.href or url.toString() — the token is visible in the query string.
 * If debug logging is added, redact it: work on a copy with url.searchParams.delete("token").
 */
export function extractWsToken(url: URL): string | null {
  return url.searchParams.get("token");
}

export function isInternalToken(token: string | null): boolean {
  if (!token || token.length !== INTERNAL_SERVICE_TOKEN.length) return false;
  try {
    return timingSafeEqual(Buffer.from(token, "utf8"), Buffer.from(INTERNAL_SERVICE_TOKEN, "utf8"));
  } catch {
    return false;
  }
}

export async function handleAuthChannel(req: Request, url: URL): Promise<Response> {
  if (req.method === "GET") {
    const channel = url.searchParams.get("channel") || "";
    return json({ ok: true, requires_auth: isChannelAuthRequired(channel) });
  }
  if (req.method === "POST") {
    const body = await parseBody(req);
    const { channel, token } = body;
    if (!channel || !token) {
      return json({ ok: false, error: "channel and token required" }, 400);
    }
    // Never accept the internal service token from external callers
    if (isInternalToken(String(token))) return json({ ok: false });
    return json({ ok: validateApiToken(String(token), String(channel)) });
  }
  return json({ ok: false, error: "Method not allowed" }, 405);
}

/**
 * Validate that a request passes auth checks for API/MCP routes.
 * Returns a 401 Response on failure, or null if auth passes / is not required.
 *
 * IMPORTANT: /mcp/agent/ and /mcp/space/ are agent-internal endpoints — no auth required.
 *   /mcp/agent/ is used by Claude Code agents running as subprocesses inside the channel.
 *   /mcp/space/ has its own per-space token validation inside handleSpaceMcpRequest.
 *
 * SECURITY NOTE: /mcp/agent/ is intentionally unauthenticated because it is only reachable
 *   by local subprocesses (Claude Code agents) that share the same process namespace.
 *   External network access to this path is expected to be blocked by the server binding to
 *   localhost (127.0.0.1) in production. Do NOT expose this path on a public network
 *   interface without adding authentication.
 */
export function validateApiKey(req: Request, url: URL, path: string, isAuthEnabled: () => boolean): Response | null {
  const isAgentMcpPath = path.startsWith("/mcp/agent/") || path.startsWith("/mcp/space/");
  if (!isAgentMcpPath && (path.startsWith("/api/") || path.startsWith("/mcp"))) {
    if (isAuthEnabled()) {
      const token = extractToken(req);
      if (!isInternalToken(token)) {
        const channel = url.searchParams.get("channel") ?? undefined;
        // Channel-scoped auth: only enforce auth when the specific channel requires it.
        // Global endpoints without a ?channel= param are gated only if a global "*"
        // catch-all is configured; otherwise they are allowed through.
        const authRequired = channel ? isChannelAuthRequired(channel) : hasGlobalAuth();
        if (authRequired && !validateApiToken(token, channel)) {
          return new Response(JSON.stringify({ ok: false, error: "Unauthorized" }), {
            status: 401,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        }
      }
    }
  }
  return null;
}
