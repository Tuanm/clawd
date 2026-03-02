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
  return loadConfig().providers?.cpa;
}

export function getEnv(key: string): string | undefined {
  const config = loadConfig();
  return config.env?.[key] || process.env[key];
}
