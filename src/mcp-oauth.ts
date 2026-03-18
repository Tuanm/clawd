/**
 * MCP OAuth Token Management
 *
 * Stores and loads OAuth tokens for MCP servers.
 * Tokens are stored in ~/.clawd/mcp-oauth-tokens.json
 *
 * Supports OAuth 2.1 auto-discovery:
 *  - RFC 9728: Protected Resource Metadata (/.well-known/oauth-protected-resource)
 *  - RFC 8414: Authorization Server Metadata (/.well-known/oauth-authorization-server)
 *  - RFC 7591: Dynamic Client Registration
 *  - PKCE (S256) for all authorization code flows
 */

import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const TOKENS_PATH = join(homedir(), ".clawd", "mcp-oauth-tokens.json");

export interface OAuthToken {
  access_token: string;
  refresh_token?: string;
  token_type?: string;
  expires_at?: number; // Unix timestamp in ms
  scopes?: string[];
}

/** Discovered OAuth metadata for an MCP server */
export interface OAuthDiscoveryResult {
  authorization_endpoint: string;
  token_endpoint: string;
  registration_endpoint?: string;
  scopes_supported?: string[];
  code_challenge_methods_supported?: string[];
  token_endpoint_auth_methods_supported?: string[];
  // After dynamic client registration:
  client_id?: string;
  client_secret?: string;
}

/** Key format: "channel:serverName" */
type TokenStore = Record<string, OAuthToken>;

function loadTokenStore(): TokenStore {
  try {
    if (existsSync(TOKENS_PATH)) {
      return JSON.parse(readFileSync(TOKENS_PATH, "utf-8"));
    }
  } catch (err) {
    console.warn("[mcp-oauth] Failed to load token store:", err);
  }
  return {};
}

function saveTokenStore(store: TokenStore): void {
  const dir = join(homedir(), ".clawd");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(TOKENS_PATH, JSON.stringify(store, null, 2), { encoding: "utf-8", mode: 0o600 });
}

export function loadOAuthToken(channel: string, serverName: string): OAuthToken | null {
  const store = loadTokenStore();
  const token = store[`${channel}:${serverName}`] || null;
  if (token?.expires_at && token.expires_at < Date.now()) {
    console.warn(`[mcp-oauth] Token for ${channel}:${serverName} has expired`);
    return null;
  }
  return token;
}

export function saveOAuthToken(channel: string, serverName: string, token: OAuthToken): void {
  const store = loadTokenStore();
  store[`${channel}:${serverName}`] = token;
  saveTokenStore(store);
}

export function removeOAuthToken(channel: string, serverName: string): void {
  const store = loadTokenStore();
  delete store[`${channel}:${serverName}`];
  saveTokenStore(store);
}

// ============================================================================
// OAuth Auto-Discovery (RFC 9728 + RFC 8414 + RFC 7591)
// ============================================================================

/**
 * Discover OAuth metadata for an HTTP MCP server URL.
 *
 * 1. Fetches /.well-known/oauth-protected-resource from the MCP server
 *    to find the authorization server(s).
 * 2. Fetches /.well-known/oauth-authorization-server from the auth server
 *    to get endpoints (authorize, token, registration).
 * 3. If a registration_endpoint exists, dynamically registers as a client
 *    to obtain a client_id.
 *
 * Returns null if the server doesn't support OAuth discovery.
 */
export async function discoverOAuthMetadata(
  serverUrl: string,
  callbackUrl: string,
  clientName = "Clawd",
): Promise<OAuthDiscoveryResult | null> {
  const origin = new URL(serverUrl).origin;

  // Step 1: Protected Resource Metadata (RFC 9728)
  let authServerUrl: string;
  try {
    const prm = await fetchJson(`${origin}/.well-known/oauth-protected-resource`);
    if (!prm?.authorization_servers?.length) {
      console.log("[mcp-oauth] No authorization_servers in protected resource metadata");
      return null;
    }
    authServerUrl = prm.authorization_servers[0];
  } catch (err: any) {
    console.log(`[mcp-oauth] No protected resource metadata at ${origin}: ${err.message}`);
    return null;
  }

  // Step 2: Authorization Server Metadata (RFC 8414)
  // Preserve path for tenant-isolated auth servers (e.g. https://auth.example.com/tenant1)
  const authUrl = new URL(authServerUrl);
  const authBase =
    authUrl.pathname === "/" ? authUrl.origin : `${authUrl.origin}${authUrl.pathname.replace(/\/+$/, "")}`;
  let asMeta: any;
  try {
    // RFC 8414 §3: for path-based issuers, insert .well-known between host and path
    const wellKnownUrl =
      authUrl.pathname === "/"
        ? `${authUrl.origin}/.well-known/oauth-authorization-server`
        : `${authUrl.origin}/.well-known/oauth-authorization-server${authUrl.pathname}`;
    asMeta = await fetchJson(wellKnownUrl);
  } catch (err: any) {
    console.warn(`[mcp-oauth] Failed to fetch auth server metadata from ${authBase}: ${err.message}`);
    return null;
  }

  if (!asMeta?.authorization_endpoint || !asMeta?.token_endpoint) {
    console.warn("[mcp-oauth] Auth server metadata missing required endpoints");
    return null;
  }

  const result: OAuthDiscoveryResult = {
    authorization_endpoint: asMeta.authorization_endpoint,
    token_endpoint: asMeta.token_endpoint,
    registration_endpoint: asMeta.registration_endpoint,
    scopes_supported: asMeta.scopes_supported,
    code_challenge_methods_supported: asMeta.code_challenge_methods_supported,
    token_endpoint_auth_methods_supported: asMeta.token_endpoint_auth_methods_supported,
  };

  // Step 3: Client registration — try multiple strategies per MCP SDK behavior:
  // 3a. CIMD (SEP-991): Use URL-based client_id if server supports it
  // 3b. DCR at advertised registration_endpoint (RFC 7591)
  // 3c. DCR at /register fallback path on auth server
  const regPayload = {
    client_name: clientName,
    redirect_uris: [callbackUrl],
    token_endpoint_auth_method: "none",
    grant_types: ["authorization_code"],
    response_types: ["code"],
  };

  // 3a: Check for CIMD support (SEP-991 URL-based Client IDs)
  if (asMeta.client_id_metadata_document_supported && callbackUrl) {
    // Server supports URL-based client_id — we can use our callback origin as client_id
    const clientMetadataUrl = new URL(callbackUrl).origin + "/.well-known/oauth-client.json";
    result.client_id = clientMetadataUrl;
    console.log(`[mcp-oauth] Using URL-based client_id (CIMD): ${clientMetadataUrl}`);
    return result;
  }

  // 3b: DCR at advertised registration_endpoint
  if (asMeta.registration_endpoint) {
    const regResult = await tryDynamicRegistration(asMeta.registration_endpoint, regPayload);
    if (regResult) {
      result.client_id = regResult.client_id;
      result.client_secret = regResult.client_secret;
      return result;
    }
  }

  // 3c: DCR at /register fallback on auth server (MCP SDK convention)
  if (!result.client_id) {
    const fallbackUrl = `${authBase}/register`;
    if (fallbackUrl !== asMeta.registration_endpoint) {
      console.log(`[mcp-oauth] Trying DCR fallback at ${fallbackUrl}`);
      const regResult = await tryDynamicRegistration(fallbackUrl, regPayload);
      if (regResult) {
        result.client_id = regResult.client_id;
        result.client_secret = regResult.client_secret;
        result.registration_endpoint = fallbackUrl;
      }
    }
  }

  return result;
}

/** Attempt Dynamic Client Registration at a given endpoint. Returns null on failure. */
async function tryDynamicRegistration(
  endpoint: string,
  payload: Record<string, any>,
): Promise<{ client_id: string; client_secret?: string } | null> {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 10000);
    const regResponse = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: ctrl.signal,
      redirect: "error", // Don't follow redirects (HTML login pages)
    });
    clearTimeout(timer);

    if (regResponse.ok) {
      const contentType = regResponse.headers.get("content-type") || "";
      if (!contentType.includes("json")) {
        console.warn(`[mcp-oauth] DCR at ${endpoint} returned non-JSON response`);
        return null;
      }
      const regData = (await regResponse.json()) as any;
      if (regData.client_id) {
        console.log(`[mcp-oauth] Dynamic client registration successful at ${endpoint}: ${regData.client_id}`);
        return { client_id: regData.client_id, client_secret: regData.client_secret || undefined };
      }
    } else {
      console.warn(`[mcp-oauth] DCR at ${endpoint} failed (${regResponse.status})`);
    }
  } catch (err: any) {
    console.warn(`[mcp-oauth] DCR at ${endpoint} error: ${err.message}`);
  }
  return null;
}

async function fetchJson(url: string): Promise<any> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 10000);
  try {
    const res = await fetch(url, {
      headers: { Accept: "application/json" },
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

// ============================================================================
// PKCE Helpers (RFC 7636)
// ============================================================================

function generateCodeVerifier(): string {
  return randomBytes(32).toString("base64url");
}

function computeCodeChallenge(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

// ============================================================================
// OAuth Flow State Management
// ============================================================================

interface PendingFlow {
  channel: string;
  server: string;
  code_verifier: string;
  client_id: string;
  client_secret?: string;
  token_endpoint: string;
  redirect_uri: string;
  timeout: ReturnType<typeof setTimeout>;
}

/** Pending OAuth flows awaiting callback — maps nonce → flow metadata */
const pendingFlows = new Map<string, PendingFlow>();

/** Validate and consume a pending OAuth flow nonce. Returns flow metadata including PKCE verifier. */
export function validateOAuthState(stateParam: string): PendingFlow | null {
  try {
    const parsed = JSON.parse(stateParam) as { nonce: string; channel: string; server: string };
    const flow = pendingFlows.get(parsed.nonce);
    if (!flow || flow.channel !== parsed.channel || flow.server !== parsed.server) return null;
    clearTimeout(flow.timeout);
    pendingFlows.delete(parsed.nonce);
    return flow;
  } catch {
    return null;
  }
}

/**
 * Generate OAuth authorization URL with PKCE and register pending callback.
 *
 * Accepts either manual oauth config or discovered metadata.
 */
export function startOAuthFlow(
  channel: string,
  serverName: string,
  oauth: {
    client_id: string;
    client_secret?: string;
    authorize_url?: string;
    token_url?: string;
    scopes?: string[];
  },
  callbackBaseUrl: string,
): { auth_url: string; state: string } {
  if (!oauth.authorize_url) {
    throw new Error("authorize_url is required in OAuth config");
  }
  if (!oauth.token_url) {
    throw new Error("token_url is required in OAuth config");
  }

  const nonce = crypto.randomUUID();
  const callbackUrl = `${callbackBaseUrl}/api/mcp/oauth/callback`;
  const stateJson = JSON.stringify({ nonce, channel, server: serverName });

  // PKCE
  const codeVerifier = generateCodeVerifier();
  const codeChallenge = computeCodeChallenge(codeVerifier);

  const params = new URLSearchParams({
    client_id: oauth.client_id,
    redirect_uri: callbackUrl,
    response_type: "code",
    state: stateJson,
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
  });
  if (oauth.scopes?.length) {
    // Use comma separator for Slack-style scopes (containing colons), space for standard OAuth
    const sep = oauth.scopes.some((s) => s.includes(":")) ? "," : " ";
    params.set("scope", oauth.scopes.join(sep));
  }

  const authUrl = `${oauth.authorize_url}?${params.toString()}`;
  const scopeCount = oauth.scopes?.length || 0;
  // lgtm[js/clear-text-logging]
  console.log(`[mcp-oauth] Starting OAuth flow: channel=${channel}, server=${serverName}, scopes=${scopeCount}`);

  // Register pending flow with 5-min timeout
  const timeout = setTimeout(() => pendingFlows.delete(nonce), 5 * 60 * 1000);
  pendingFlows.set(nonce, {
    channel,
    server: serverName,
    code_verifier: codeVerifier,
    client_id: oauth.client_id,
    client_secret: oauth.client_secret,
    token_endpoint: oauth.token_url,
    redirect_uri: callbackUrl,
    timeout,
  });

  return { auth_url: authUrl, state: stateJson };
}

/**
 * Exchange OAuth authorization code for access token (with PKCE)
 */
export async function exchangeOAuthCode(
  code: string,
  tokenUrl: string,
  clientId: string,
  redirectUri: string,
  codeVerifier?: string,
  clientSecret?: string,
): Promise<OAuthToken> {
  const bodyParams: Record<string, string> = {
    grant_type: "authorization_code",
    code,
    client_id: clientId,
    redirect_uri: redirectUri,
  };
  if (codeVerifier) bodyParams.code_verifier = codeVerifier;
  if (clientSecret) bodyParams.client_secret = clientSecret;

  console.log(
    `[mcp-oauth] Token exchange: has_url=${!!tokenUrl}, has_client_id=${!!clientId}, has_verifier=${!!codeVerifier}, has_secret=${!!clientSecret}`,
  );

  const headers: Record<string, string> = {
    "Content-Type": "application/x-www-form-urlencoded",
  };

  const res = await fetch(tokenUrl, {
    method: "POST",
    headers,
    body: new URLSearchParams(bodyParams).toString(),
  });

  const rawText = await res.text();
  console.log(`[mcp-oauth] Token response: status=${res.status}, body=${rawText.slice(0, 500)}`);

  if (!res.ok) {
    throw new Error(`Token exchange failed (${res.status}): ${rawText}`);
  }

  let data: any;
  try {
    data = JSON.parse(rawText);
  } catch {
    throw new Error(`Token response not JSON: ${rawText.slice(0, 200)}`);
  }

  // Handle providers that return HTTP 200 with error payloads (e.g., Slack)
  if (data.ok === false && data.error) {
    throw new Error(`Token endpoint error: ${data.error}`);
  }
  if (!data.access_token) {
    throw new Error("Token response missing access_token");
  }

  const token: OAuthToken = {
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    token_type: data.token_type || "Bearer",
    // Split on both space and comma to handle standard OAuth and Slack-style scopes
    scopes: data.scope ? data.scope.split(/[\s,]+/).filter(Boolean) : undefined,
  };
  if (data.expires_in) {
    token.expires_at = Date.now() + data.expires_in * 1000;
  }

  return token;
}

export function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
