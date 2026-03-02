import { existsSync, readFileSync } from 'node:fs';

interface ClaWdConfig {
  providers?: {
    cpa?: { base_url: string; api_key: string; models?: Record<string, string> };
  };
  env?: Record<string, string>;
  workspace?: {
    auth_token?: string;
    vnc_enabled?: boolean;
  };
}

let _config: ClaWdConfig | null = null;

export function loadConfig(): ClaWdConfig {
  if (_config) return _config;
  const paths = ['/etc/clawd/config.json', process.env.CLAWD_CONFIG_PATH || ''];
  for (const p of paths) {
    if (p && existsSync(p)) {
      try { _config = JSON.parse(readFileSync(p, 'utf-8')); return _config!; } catch {}
    }
  }
  _config = {};
  return _config;
}

export function getAuthToken(): string {
  const config = loadConfig();
  return config.workspace?.auth_token || process.env.WORKSPACE_AUTH_TOKEN || '';
}

export function getCpaConfig() {
  const fromConfig = loadConfig().providers?.cpa;
  if (fromConfig) return fromConfig;
  // Fallback to env vars injected by the host (no config file mount needed)
  const base_url = process.env.CLAWD_CPA_BASE_URL;
  const api_key = process.env.CLAWD_CPA_API_KEY;
  if (base_url && api_key) {
    let models: Record<string, string> | undefined;
    try { if (process.env.CLAWD_CPA_MODELS) models = JSON.parse(process.env.CLAWD_CPA_MODELS); } catch {}
    return { base_url, api_key, models };
  }
  return null;
}

export function getEnv(key: string): string | undefined {
  const config = loadConfig();
  return config.env?.[key] || process.env[key];
}
