/**
 * MCP OAuth Token Management
 *
 * Stores and loads OAuth tokens for MCP servers.
 * Tokens are stored in ~/.clawd/mcp-oauth-tokens.json
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const TOKENS_PATH = join(homedir(), ".clawd", "mcp-oauth-tokens.json");

export interface OAuthToken {
  access_token: string;
  refresh_token?: string;
  token_type?: string;
  expires_at?: number; // Unix timestamp in ms
  scopes?: string[];
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
    // TODO: implement token refresh using refresh_token
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
// OAuth Flow State Management
// ============================================================================

/** Pending OAuth flows awaiting callback — maps nonce → flow metadata */
const pendingFlows = new Map<string, { channel: string; server: string; timeout: ReturnType<typeof setTimeout> }>();

/** Validate and consume a pending OAuth flow nonce */
export function validateOAuthState(stateParam: string): { channel: string; server: string } | null {
  try {
    const parsed = JSON.parse(stateParam) as { nonce: string; channel: string; server: string };
    const flow = pendingFlows.get(parsed.nonce);
    if (!flow || flow.channel !== parsed.channel || flow.server !== parsed.server) return null;
    clearTimeout(flow.timeout);
    pendingFlows.delete(parsed.nonce);
    return { channel: flow.channel, server: flow.server };
  } catch {
    return null;
  }
}

/**
 * Generate OAuth authorization URL and register pending callback
 */
export function startOAuthFlow(
  channel: string,
  serverName: string,
  oauth: { client_id: string; authorize_url?: string; token_url?: string; scopes?: string[] },
  callbackBaseUrl: string,
): { auth_url: string; state: string } {
  if (!oauth.authorize_url) {
    throw new Error("authorize_url is required in OAuth config");
  }

  const nonce = crypto.randomUUID();
  const callbackUrl = `${callbackBaseUrl}/api/mcp/oauth/callback`;
  const stateJson = JSON.stringify({ nonce, channel, server: serverName });

  const params = new URLSearchParams({
    client_id: oauth.client_id,
    redirect_uri: callbackUrl,
    response_type: "code",
    state: stateJson,
  });
  if (oauth.scopes?.length) params.set("scope", oauth.scopes.join(" "));

  const authUrl = `${oauth.authorize_url}?${params.toString()}`;

  // Register pending flow with 5-min timeout
  const timeout = setTimeout(() => pendingFlows.delete(nonce), 5 * 60 * 1000);
  pendingFlows.set(nonce, { channel, server: serverName, timeout });

  return { auth_url: authUrl, state: stateJson };
}

/**
 * Exchange OAuth authorization code for access token
 */
export async function exchangeOAuthCode(
  code: string,
  tokenUrl: string,
  clientId: string,
  redirectUri: string,
): Promise<OAuthToken> {
  const res = await fetch(tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      client_id: clientId,
      redirect_uri: redirectUri,
    }).toString(),
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
