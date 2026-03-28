/**
 * Generic LLM Provider Interface
 *
 * Defines the contract for LLM provider implementations.
 * Supports OpenAI-compatible, Anthropic-compatible, and GitHub Copilot providers.
 */

// ============================================================================
// Types (imported from shared types module and re-exported for consumers)
// ============================================================================

import type {
  CompletionRequest,
  CompletionResponse,
  Message,
  StreamEvent,
  ToolCall,
  ToolDefinition,
} from "./types";

export type {
  CompletionRequest,
  CompletionResponse,
  Message,
  StreamEvent,
  ToolCall,
  ToolDefinition,
};

// ============================================================================
// Provider Interface
// ============================================================================

/**
 * Generic LLM Provider interface
 *
 * All provider implementations must implement this interface.
 * This allows the Agent class to work with any LLM provider.
 */
export interface LLMProvider {
  /** The default model for this provider */
  readonly model: string;

  /**
   * Make a non-streaming completion request
   */
  complete(request: CompletionRequest): Promise<CompletionResponse>;

  /**
   * Make a streaming completion request
   * @param signal Optional abort signal
   */
  stream(request: CompletionRequest, signal?: AbortSignal, initiator?: "agent" | "user"): AsyncGenerator<StreamEvent>;

  /**
   * Close any open connections
   */
  close(): void;

  /**
   * Fetch token limit for a model from the provider API.
   * Returns null if the provider doesn't expose this info.
   * Optional — providers that don't support it simply don't implement it.
   */
  fetchModelTokenLimit?(model: string): Promise<number | null>;
}

// ============================================================================
// Provider Types
// ============================================================================

export type ProviderType = "openai" | "anthropic" | "copilot" | "ollama" | "claude-code";

/** Built-in provider names (recognized without a `type` field) */
export const BUILTIN_PROVIDERS: readonly ProviderType[] = ["openai", "anthropic", "copilot", "ollama", "claude-code"];

export interface ProviderConfig {
  /**
   * Base provider type. When set, this entry is a *custom* provider that
   * inherits the API logic of `type` (e.g., "openai", "anthropic") but
   * overrides base_url, api_key(s), and models.
   * Built-in providers (openai, anthropic, copilot, ollama) do not need
   * this field.
   */
  type?: string;
  // Common
  api_key?: string;
  /** List of API keys for rotation. Ignored if `api_key` is also set. */
  api_keys?: string[];
  base_url?: string;
  models?: {
    default?: string;
    sonnet?: string;
    opus?: string;
    [key: string]: string | undefined;
  };
  // Custom headers for API requests
  headers?: Record<string, string>;
}

export interface CopilotProviderConfig extends ProviderConfig {
  /** @deprecated Use `api_key` instead. Kept for backward compatibility. */
  token?: string;
  /** Set to false to disable this provider */
  enabled?: boolean;
}

export interface OllamaProviderConfig {
  api_key?: string;
  /** List of API keys for rotation. Ignored if `api_key` is also set. */
  api_keys?: string[];
  base_url?: string;
  models?: {
    default?: string;
    [key: string]: string | undefined;
  };
}

// MCP Server configuration
export interface MCPServerConfig {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string; // For HTTP transport
  headers?: Record<string, string>; // Custom headers for HTTP transport
  transport?: "stdio" | "http";
  enabled?: boolean; // false = temporarily disconnected
  logo?: string; // URL, base64 image, or SVG code
  oauth?: {
    client_id: string;
    client_secret?: string;
    authorize_url?: string; // OAuth authorization endpoint
    token_url?: string; // OAuth token exchange endpoint
    registration_endpoint?: string; // Dynamic client registration endpoint
    scopes?: string[];
  };
}

export interface Config {
  /**
   * Provider configurations.
   * Built-in keys: "openai", "anthropic", "copilot", "ollama".
   * Any additional key is a *custom* provider — it must include a `type` field
   * pointing to the built-in provider whose API logic to inherit.
   *
   * Example custom provider (Groq via OpenAI-compatible API):
   *   "groq": {
   *     "type": "openai",
   *     "base_url": "https://api.groq.com/openai/v1",
   *     "api_key": "gsk_...",
   *     "models": { "default": "llama-3.3-70b-versatile" }
   *   }
   *
   * CPA (legacy) can be used as: "cpa": { "type": "openai", ... }
   */
  providers: Record<string, ProviderConfig | CopilotProviderConfig | OllamaProviderConfig>;
  /**
   * MCP servers configuration. Channel-scoped format:
   * { "channel-name": { "server-name": { command, args, env } } }
   */
  mcp_servers?: Record<string, Record<string, MCPServerConfig>>;
}
