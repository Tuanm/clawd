/**
 * Provider Configuration Loader
 *
 * Loads LLM provider configuration from ~/.clawd/config.json
 * and provides utilities for provider selection.
 *
 * Optimized with caching to avoid repeated file reads.
 */

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type {
  ProviderConfig,
  CopilotProviderConfig,
  OllamaProviderConfig,
  Config,
  ProviderType,
  MCPServerConfig,
} from "./providers";

// ============================================================================
// Config Caching
// ============================================================================

const DEFAULT_CONFIG_PATH = join(homedir(), ".clawd", "config.json");
let cachedConfig: Config | null = null;
let cachedConfigPath: string | null = null;

/**
 * Load provider configuration from ~/.clawd/config.json (with caching)
 */
export function loadConfig(configPath?: string): Config {
  const filePath = configPath || DEFAULT_CONFIG_PATH;

  // Return cached config if available
  if (cachedConfig && cachedConfigPath === filePath) {
    return cachedConfig;
  }

  if (!existsSync(filePath)) {
    cachedConfig = getDefaultConfig();
    cachedConfigPath = filePath;
    return cachedConfig;
  }

  try {
    const content = readFileSync(filePath, "utf-8");
    const parsed = JSON.parse(content);

    // Return parsed config or default if providers not defined
    if (!parsed.providers) {
      cachedConfig = getDefaultConfig();
    } else {
      cachedConfig = parsed as Config;
    }
    cachedConfigPath = filePath;
    return cachedConfig;
  } catch (err) {
    console.error(`[Provider Config] Failed to load config from ${filePath}:`, err);
    cachedConfig = getDefaultConfig();
    cachedConfigPath = filePath;
    return cachedConfig;
  }
}

/**
 * Clear config cache (useful for testing)
 */
export function clearConfigCache(): void {
  cachedConfig = null;
  cachedConfigPath = null;
  reinitKeyPool();
}

/**
 * Get the default configuration
 */
function getDefaultConfig(): Config {
  return {
    providers: {
      ollama: {
        base_url: "https://ollama.com",
        models: { default: "glm-5:cloud" },
      },
    },
  };
}

/**
 * Get the selected provider type
 * Reads from ~/.clawd/config.json only
 */
export function getSelectedProvider(): ProviderType {
  const config = loadConfig();

  // Check if any provider is configured (order matters - first match wins)
  if (config.providers?.ollama?.base_url) {
    return "ollama";
  }
  if (
    config.providers?.copilot?.enabled !== false &&
    (config.providers?.copilot?.api_key || config.providers?.copilot?.token)
  ) {
    return "copilot";
  }
  if (config.providers?.openai?.api_key) {
    return "openai";
  }
  if (config.providers?.anthropic?.api_key) {
    return "anthropic";
  }
  if (config.providers?.cpa?.api_key || config.providers?.cpa?.base_url) {
    return "cpa";
  }

  // Default to copilot if no config found
  return "copilot";
}

/**
 * Get provider configuration for a specific provider type
 */
export function getProviderConfig(
  providerType: ProviderType,
): ProviderConfig | CopilotProviderConfig | OllamaProviderConfig | undefined {
  const config = loadConfig();
  const provider = config.providers?.[providerType];
  if (providerType === "copilot") {
    return provider as CopilotProviderConfig | undefined;
  }
  if (providerType === "ollama") {
    return provider as OllamaProviderConfig | undefined;
  }
  return provider as ProviderConfig | undefined;
}

/**
 * Map short model names to full model names using config
 * Reads aliases from ~/.clawd/config.json under each provider's models config
 *
 * When providerType is specified, only that provider's aliases are checked.
 * This prevents cross-provider alias collisions (e.g., "opus" mapping to
 * different models under anthropic vs copilot).
 *
 * When providerType is omitted, all providers are searched (legacy behavior).
 */
export function mapModelName(model: string, providerType?: ProviderType): string {
  const lower = model.toLowerCase().trim();
  const config = loadConfig();

  if (providerType) {
    // Check only the specified provider's aliases
    const provider = (config.providers as any)?.[providerType];
    if (provider?.models) {
      for (const [alias, modelName] of Object.entries(provider.models)) {
        if (alias.toLowerCase() === lower && modelName) {
          return modelName as string;
        }
      }
    }
  } else {
    // Fallback: search all providers (legacy behavior)
    for (const [, provider] of Object.entries(config.providers || {})) {
      if (provider?.models) {
        for (const [alias, modelName] of Object.entries(provider.models)) {
          if (alias.toLowerCase() === lower && modelName) {
            return modelName as string;
          }
        }
      }
    }
  }

  // No mapping found, return original
  return model;
}

/**
 * Get the model to use for a provider
 * Reads from ~/.clawd/config.json only
 */
export function getModelForProvider(providerType: ProviderType): string {
  const providerConfig = getProviderConfig(providerType);
  if (providerConfig && providerConfig.models?.default) {
    const configModel = providerConfig.models.default;
    const resolved = mapModelName(configModel, providerType);
    if (configModel !== resolved) {
      console.log(`[Provider] Model mapping: "${configModel}" → "${resolved}" (${providerType})`);
    }
    return resolved;
  }

  // Default models
  const defaultModels: Record<ProviderType, string> = {
    anthropic: "claude-sonnet-4-6",
    openai: "gpt-4o",
    copilot: "claude-sonnet-4.6",
    ollama: "glm-5:cloud",
    cpa: "claude-sonnet-4-6",
  };

  return defaultModels[providerType];
}

/**
 * Get the base URL for a provider
 */
export function getBaseUrlForProvider(providerType: ProviderType): string | undefined {
  const providerConfig = getProviderConfig(providerType);
  return providerConfig?.base_url;
}

// ============================================================================
// API Key Rotation
// ============================================================================

import { keyPool } from "./key-pool";

/** Round-robin counter per provider (non-Copilot providers only) */
const keyRotationCounters: Partial<Record<ProviderType, number>> = {};

/**
 * Get the effective API key for a provider, supporting key rotation.
 * For Copilot, delegates to KeyPool. For other providers, uses round-robin.
 */
export function getApiKeyForProvider(providerType: ProviderType): string | undefined {
  if (providerType === "copilot") {
    return getCopilotToken() ?? undefined;
  }

  const providerConfig = getProviderConfig(providerType);
  if (!providerConfig) return undefined;

  // api_key takes precedence over api_keys
  if (providerConfig.api_key) {
    return providerConfig.api_key;
  }

  const keys = (providerConfig as any).api_keys as string[] | undefined;
  if (keys && keys.length > 0) {
    const counter = keyRotationCounters[providerType] ?? 0;
    const key = keys[counter % keys.length];
    keyRotationCounters[providerType] = (counter + 1) % keys.length;
    return key;
  }

  return undefined;
}

/**
 * Collect all Copilot tokens from config (api_key, api_keys, legacy token).
 * Used to initialize the KeyPool.
 */
function getCopilotTokensFromConfig(): string[] {
  const config = loadConfig();
  const copilot = config.providers?.copilot;
  if (!copilot) return [];

  const tokens: string[] = [];
  if (copilot.api_key) tokens.push(copilot.api_key);
  const apiKeys = (copilot as any).api_keys as string[] | undefined;
  if (Array.isArray(apiKeys)) tokens.push(...apiKeys);
  if (copilot.token && !tokens.includes(copilot.token)) tokens.push(copilot.token);
  return tokens.filter(Boolean);
}

let keyPoolReady = false;

function ensureKeyPoolInitialized(): void {
  if (keyPoolReady) return;
  keyPoolReady = true;
  const tokens = getCopilotTokensFromConfig();
  if (tokens.length > 0) {
    keyPool.init(tokens);
  }
}

/**
 * Get the API key for Copilot provider — delegates to KeyPool.
 * Uses peekToken() (NOT selectKey) to avoid leaking inFlight counters.
 * For actual request accounting, callers use keyPool.selectKey() + recordRequest().
 * Returns null if no healthy key is available.
 */
export function getCopilotToken(): string | null {
  ensureKeyPoolInitialized();
  const token = keyPool.peekToken("agent");
  if (token) return token;
  // Fallback: legacy single token from config
  const config = loadConfig();
  return config.providers?.copilot?.token || null;
}

/**
 * Re-initialize the KeyPool after a config reload (e.g. new keys added).
 * Called by clearConfigCache() when config is hot-reloaded.
 */
export function reinitKeyPool(): void {
  keyPoolReady = false;
  ensureKeyPoolInitialized();
}

export { ensureKeyPoolInitialized };

// ============================================================================
// MCP Server Configuration
// ============================================================================

/**
 * Get all MCP servers from config
 * Returns MCP servers defined in ~/.clawd/config.json under mcp_servers
 */
export function getMCPServers(): Record<string, MCPServerConfig> {
  const config = loadConfig();
  return config.mcp_servers || {};
}

/**
 * Get a specific MCP server by name
 */
export function getMCPServer(name: string): MCPServerConfig | undefined {
  const servers = getMCPServers();
  return servers[name];
}

/**
 * Get all MCP server names configured
 */
export function getMCPServerNames(): string[] {
  const servers = getMCPServers();
  return Object.keys(servers);
}

/**
 * Check if any MCP servers are configured
 */
export function hasMCPServers(): boolean {
  const servers = getMCPServers();
  return Object.keys(servers).length > 0;
}
