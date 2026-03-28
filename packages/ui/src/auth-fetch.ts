const CHANNEL_TOKEN_KEY = (ch: string) => `clawd-channel-token-${ch}`;
const GLOBAL_TOKEN_KEY = "clawd-auth-token"; // legacy, kept for backward compat

export function getChannelToken(channel: string): string | null {
  try {
    return localStorage.getItem(CHANNEL_TOKEN_KEY(channel)) ?? localStorage.getItem(GLOBAL_TOKEN_KEY);
  } catch {
    return null;
  }
}

export function setChannelToken(channel: string, token: string): void {
  try {
    localStorage.setItem(CHANNEL_TOKEN_KEY(channel), token);
  } catch {}
}

export function clearChannelToken(channel: string): void {
  try {
    localStorage.removeItem(CHANNEL_TOKEN_KEY(channel));
  } catch {}
}

// Legacy functions kept for backward compat
export function getStoredAuthToken(): string | null {
  try {
    return localStorage.getItem(GLOBAL_TOKEN_KEY);
  } catch {
    return null;
  }
}
export function setStoredAuthToken(token: string): void {
  try {
    localStorage.setItem(GLOBAL_TOKEN_KEY, token);
  } catch {}
}

/**
 * Fetch wrapper that injects per-channel (or global) auth token.
 * Sends raw token without "Bearer" prefix — server accepts both formats.
 */
export async function authFetch(input: RequestInfo | URL, init?: RequestInit, channel?: string): Promise<Response> {
  const token = channel ? getChannelToken(channel) : getStoredAuthToken();
  if (token) {
    const headers = new Headers(init?.headers);
    if (!headers.has("Authorization")) headers.set("Authorization", token);
    return fetch(input, { ...init, headers });
  }
  return fetch(input, init);
}
