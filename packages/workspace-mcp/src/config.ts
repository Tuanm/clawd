import { existsSync, readFileSync } from "node:fs";

interface ClaWdConfig {
  vision?: {
    base_url?: string;
    api_key?: string;
    model?: string;
    provider?: string;
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
  const paths = ["/etc/clawd/config.json", process.env.CLAWD_CONFIG_PATH || ""];
  for (const p of paths) {
    if (p && existsSync(p)) {
      try {
        _config = JSON.parse(readFileSync(p, "utf-8"));
        return _config!;
      } catch {}
    }
  }
  _config = {};
  return _config;
}

export function getAuthToken(): string {
  const config = loadConfig();
  return config.workspace?.auth_token || process.env.WORKSPACE_AUTH_TOKEN || "";
}

/** Get the vision provider config for image analysis inside workspace containers. */
export function getVisionConfig(): { base_url: string; api_key: string; model: string; provider: string } | null {
  // Prefer env vars injected by the host (standard for Docker containers)
  const base_url = process.env.CLAWD_VISION_BASE_URL;
  const api_key = process.env.CLAWD_VISION_API_KEY;
  const model = process.env.CLAWD_VISION_MODEL || "gpt-4.1";
  const provider = process.env.CLAWD_VISION_PROVIDER || "copilot";
  if (base_url && api_key) {
    return { base_url, api_key, model, provider };
  }

  // Fallback to config file (for non-Docker environments)
  const cfg = loadConfig().vision;
  if (cfg?.base_url && cfg?.api_key) {
    return {
      base_url: cfg.base_url,
      api_key: cfg.api_key,
      model: cfg.model || "gpt-4.1",
      provider: cfg.provider || "copilot",
    };
  }
  return null;
}

export function getEnv(key: string): string | undefined {
  const config = loadConfig();
  return config.env?.[key] || process.env[key];
}
