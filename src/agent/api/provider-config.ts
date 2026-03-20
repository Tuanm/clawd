/**
 * Provider Configuration Loader
 *
 * Loads LLM provider configuration from ~/.clawd/config.json
 * and provides utilities for provider selection.
 *
 * Optimized with caching to avoid repeated file reads.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type {
  Config,
  CopilotProviderConfig,
  MCPServerConfig,
  OllamaProviderConfig,
  ProviderConfig,
  ProviderType,
} from "./providers";
import { BUILTIN_PROVIDERS } from "./providers";
export { BUILTIN_PROVIDERS };

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
  const providers = config.providers || {};

  // Check if any built-in provider is configured (order matters - first match wins)
  const ollama = providers.ollama as OllamaProviderConfig | undefined;
  if (ollama?.base_url) {
    return "ollama";
  }
  const copilot = providers.copilot as CopilotProviderConfig | undefined;
  if (copilot?.enabled !== false && (copilot?.api_key || copilot?.token)) {
    return "copilot";
  }
  const openai = providers.openai as ProviderConfig | undefined;
  if (openai?.api_key) {
    return "openai";
  }
  const anthropic = providers.anthropic as ProviderConfig | undefined;
  if (anthropic?.api_key) {
    return "anthropic";
  }
  const minimax = providers.minimax as ProviderConfig | undefined;
  if (minimax?.api_key || minimax?.base_url) {
    return "minimax";
  }

  // Default to copilot if no config found
  return "copilot";
}

/**
 * Get provider configuration for a specific provider type
 */
export function getProviderConfig(
  providerType: string,
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
 * Resolve the base built-in ProviderType for a provider name.
 * For built-in providers (openai, anthropic, etc.) returns the name itself.
 * For custom providers, reads the `type` field from their config entry.
 * Returns undefined if the provider is not found or has no resolvable type.
 */
export function resolveProviderBaseType(providerName: string): ProviderType | undefined {
  if ((BUILTIN_PROVIDERS as readonly string[]).includes(providerName)) {
    return providerName as ProviderType;
  }
  const config = loadConfig();
  const entry = config.providers?.[providerName] as ProviderConfig | undefined;
  if (entry?.type && (BUILTIN_PROVIDERS as readonly string[]).includes(entry.type)) {
    return entry.type as ProviderType;
  }
  return undefined;
}

/**
 * List all available providers: all built-in provider names (always included)
 * plus any custom providers defined in config.json with a `type` field.
 */
export function listConfiguredProviders(): Array<{
  name: string;
  type: ProviderType;
  is_custom: boolean;
}> {
  const config = loadConfig();
  const result: Array<{ name: string; type: ProviderType; is_custom: boolean }> = [];

  // Always include all built-in providers as baseline
  for (const name of BUILTIN_PROVIDERS) {
    result.push({ name, type: name, is_custom: false });
  }

  // Add custom providers (entries with a `type` field that's a built-in)
  for (const [name, entry] of Object.entries(config.providers || {})) {
    if ((BUILTIN_PROVIDERS as readonly string[]).includes(name)) continue; // skip built-ins (already added)
    const baseType = (entry as ProviderConfig)?.type as ProviderType | undefined;
    if (!baseType || !(BUILTIN_PROVIDERS as readonly string[]).includes(baseType)) continue;
    result.push({ name, type: baseType, is_custom: true });
  }

  return result;
}

/**
 * Map short model names to full model names using config
 * Reads aliases from ~/.clawd/config.json under each provider's models config
 *
 * When providerName is specified, only that provider's aliases are checked.
 * This prevents cross-provider alias collisions (e.g., "opus" mapping to
 * different models under anthropic vs copilot).
 *
 * When providerName is omitted, all providers are searched (legacy behavior).
 */
export function mapModelName(model: string, providerName?: string): string {
  const lower = model.toLowerCase().trim();
  const config = loadConfig();

  if (providerName) {
    // Check only the specified provider's aliases
    const provider = config.providers?.[providerName];
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
 * Get the model to use for a provider (built-in or custom).
 */
export function getModelForProvider(providerName: string): string {
  const providerConfig = getProviderConfig(providerName);
  if (providerConfig && providerConfig.models?.default) {
    const configModel = providerConfig.models.default;
    const resolved = mapModelName(configModel, providerName);
    if (configModel !== resolved) {
      console.log(`[Provider] Model mapping: "${configModel}" → "${resolved}" (${providerName})`);
    }
    return resolved;
  }

  // For custom providers with no default model, fall back to base type's default
  const baseType = resolveProviderBaseType(providerName);
  if (baseType && baseType !== (providerName as ProviderType)) {
    return getModelForProvider(baseType);
  }

  // Default models for built-in types
  const defaultModels: Record<ProviderType, string> = {
    anthropic: "claude-sonnet-4-6",
    openai: "gpt-4o",
    copilot: "claude-sonnet-4.6",
    ollama: "glm-5:cloud",
    minimax: "MiniMax-M2.5",
  };

  return defaultModels[providerName as ProviderType] ?? "default";
}

/**
 * Get the base URL for a provider (built-in or custom).
 */
export function getBaseUrlForProvider(providerName: string): string | undefined {
  const providerConfig = getProviderConfig(providerName);
  return providerConfig?.base_url;
}

// ============================================================================
// API Key Rotation
// ============================================================================

import { keyPool } from "./key-pool";

/** Round-robin counter per provider (non-Copilot providers only) */
const keyRotationCounters: Record<string, number> = {};

/**
 * Get the effective API key for a provider, supporting key rotation.
 * For Copilot, delegates to KeyPool. For other providers, uses round-robin.
 * Accepts both built-in provider names and custom provider names.
 */
export function getApiKeyForProvider(providerName: string): string | undefined {
  if (providerName === "copilot") {
    return getCopilotToken() ?? undefined;
  }

  const providerConfig = getProviderConfig(providerName);
  if (!providerConfig) return undefined;

  // api_key takes precedence over api_keys
  if (providerConfig.api_key) {
    return providerConfig.api_key;
  }

  const keys = (providerConfig as any).api_keys as string[] | undefined;
  if (keys && keys.length > 0) {
    const counter = keyRotationCounters[providerName] ?? 0;
    const key = keys[counter % keys.length];
    keyRotationCounters[providerName] = (counter + 1) % keys.length;
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
  const copilot = config.providers?.copilot as (CopilotProviderConfig & { token?: string }) | undefined;
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
  const copilot = config.providers?.copilot as CopilotProviderConfig | undefined;
  return copilot?.token || null;
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
/**
 * Get all channel-scoped MCP server configurations
 * Returns the full mcp_servers map: { channel → { serverName → config } }
 */
export function getAllChannelMCPServers(): Record<string, Record<string, MCPServerConfig>> {
  const config = loadConfig();
  return config.mcp_servers || {};
}

/**
 * Check if any MCP servers are configured for any channel
 */
export function hasMCPServers(): boolean {
  const channels = getAllChannelMCPServers();
  return Object.values(channels).some((servers) => Object.keys(servers).length > 0);
}

/**
 * Get MCP servers for a specific channel
 * Returns MCP servers defined in ~/.clawd/config.json under mcp_servers[channel]
 */
export function getChannelMCPServers(channel: string): Record<string, MCPServerConfig> {
  const config = loadConfig();
  const mcpServers = config.mcp_servers;
  if (!mcpServers) return {};

  // Merge global ("*") servers with channel-specific servers.
  // Channel-specific configs take precedence over global ones with the same name.
  const globalServers = channel !== "*" ? mcpServers["*"] || {} : {};
  const channelServers = mcpServers[channel] || {};

  return { ...globalServers, ...channelServers };
}

// ============================================================================
// Config Persistence (write back to ~/.clawd/config.json)
// ============================================================================

/**
 * Save a channel MCP server config to ~/.clawd/config.json
 */
export function saveChannelMCPServer(channel: string, name: string, serverConfig: MCPServerConfig): void {
  const config = loadConfig();
  if (!config.mcp_servers) config.mcp_servers = {};
  if (!config.mcp_servers[channel]) config.mcp_servers[channel] = {};
  // Merge with existing config to preserve fields like logo, enabled, etc.
  const existing = config.mcp_servers[channel][name] || {};
  config.mcp_servers[channel][name] = { ...existing, ...serverConfig };
  writeConfigToDisk(config);
}

/**
 * Remove a channel MCP server from ~/.clawd/config.json
 */
export function removeChannelMCPServer(channel: string, name: string): void {
  const config = loadConfig();
  if (config.mcp_servers?.[channel]) {
    delete config.mcp_servers[channel][name];
    if (Object.keys(config.mcp_servers[channel]).length === 0) {
      delete config.mcp_servers[channel];
    }
  }
  writeConfigToDisk(config);
}

/**
 * Update the enabled field of a channel MCP server
 */
export function setChannelMCPServerEnabled(channel: string, name: string, enabled: boolean): void {
  const config = loadConfig();
  if (config.mcp_servers?.[channel]?.[name]) {
    config.mcp_servers[channel][name].enabled = enabled;
    writeConfigToDisk(config);
  }
}

/**
 * Write config back to disk and update cache
 */
function writeConfigToDisk(config: Config): void {
  const dir = join(homedir(), ".clawd");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(DEFAULT_CONFIG_PATH, JSON.stringify(config, null, 2), "utf-8");
  cachedConfig = config;
  cachedConfigPath = DEFAULT_CONFIG_PATH;
}
