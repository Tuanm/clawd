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

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { createHash, randomBytes } from "node:crypto";

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
    asMeta = await fetchJson(`${authBase}/.well-known/oauth-authorization-server`);
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
  };

  // Step 3: Dynamic Client Registration (RFC 7591), if available
  if (asMeta.registration_endpoint) {
    try {
      const regResponse = await fetch(asMeta.registration_endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          client_name: clientName,
          redirect_uris: [callbackUrl],
          token_endpoint_auth_method: "none",
          grant_types: ["authorization_code"],
          response_types: ["code"],
          // PKCE enforced — public client with code_challenge is standard OAuth 2.1
        }),
      });

      if (regResponse.ok) {
        const regData = (await regResponse.json()) as any;
        result.client_id = regData.client_id;
        result.client_secret = regData.client_secret || undefined;
        console.log(`[mcp-oauth] Dynamic client registration successful: ${result.client_id}`);
      } else {
        console.warn(
          `[mcp-oauth] Dynamic registration failed (${regResponse.status}), client_id may need manual config`,
        );
      }
    } catch (err: any) {
      console.warn(`[mcp-oauth] Dynamic registration error: ${err.message}`);
    }
  }

  return result;
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
  if (oauth.scopes?.length) params.set("scope", oauth.scopes.join(" "));

  const authUrl = `${oauth.authorize_url}?${params.toString()}`;

  // Register pending flow with 5-min timeout
  const timeout = setTimeout(() => pendingFlows.delete(nonce), 5 * 60 * 1000);
  pendingFlows.set(nonce, {
    channel,
    server: serverName,
    code_verifier: codeVerifier,
    client_id: oauth.client_id,
    client_secret: oauth.client_secret,
    token_endpoint: oauth.token_url,
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
  // Include client_secret in body if available (client_secret_post style)
  // This is compatible with both "none" and "client_secret_post" registrations
  if (clientSecret) bodyParams.client_secret = clientSecret;

  const headers: Record<string, string> = {
    "Content-Type": "application/x-www-form-urlencoded",
  };

  const res = await fetch(tokenUrl, {
    method: "POST",
    headers,
    body: new URLSearchParams(bodyParams).toString(),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Token exchange failed (${res.status}): ${text}`);
  }

  const data = (await res.json()) as any;
  const token: OAuthToken = {
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    token_type: data.token_type || "Bearer",
    scopes: data.scope ? data.scope.split(" ") : undefined,
  };
  if (data.expires_in) {
    token.expires_at = Date.now() + data.expires_in * 1000;
  }

  return token;
}

export function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
