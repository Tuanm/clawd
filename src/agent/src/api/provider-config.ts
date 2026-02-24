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
import type { ProviderConfig, CopilotProviderConfig, OllamaProviderConfig, Config, ProviderType } from "./providers";

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
  if (config.providers?.copilot?.enabled !== false && config.providers?.copilot?.token) {
    return "copilot";
  }
  if (config.providers?.openai?.api_key) {
    return "openai";
  }
  if (config.providers?.anthropic?.api_key) {
    return "anthropic";
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
 */
export function mapModelName(model: string): string {
  const lower = model.toLowerCase().trim();

  // If the input already looks like a full model name (contains hyphen), return as-is
  if (lower.includes("-")) {
    return model;
  }

  // Try to find mapping from any provider's models config
  const config = loadConfig();

  for (const [providerType, provider] of Object.entries(config.providers || {})) {
    if (provider?.models) {
      // Check each model alias in the config
      for (const [alias, modelName] of Object.entries(provider.models)) {
        if (alias.toLowerCase() === lower && modelName) {
          return modelName;
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
    return mapModelName(providerConfig.models.default);
  }

  // Default models
  const defaultModels: Record<ProviderType, string> = {
    anthropic: "claude-sonnet-4-6",
    openai: "gpt-4o",
    copilot: "claude-sonnet-4.6",
    ollama: "glm-5:cloud",
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

/**
 * Get the API key for a provider
 */
export function getApiKeyForProvider(providerType: ProviderType): string | undefined {
  const providerConfig = getProviderConfig(providerType);
  return providerConfig?.api_key;
}

/**
 * Get the GitHub token for Copilot provider
 */
export function getCopilotToken(): string | null {
  const config = loadConfig();
  return config.providers?.copilot?.token || null;
}
