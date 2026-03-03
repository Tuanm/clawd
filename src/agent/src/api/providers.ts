/**
 * Generic LLM Provider Interface
 *
 * Defines the contract for LLM provider implementations.
 * Supports OpenAI-compatible, Anthropic-compatible, and GitHub Copilot providers.
 */

// ============================================================================
// Types
// ============================================================================

export interface Message {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}

export interface ToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}

export interface ToolDefinition {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: {
      type: "object";
      properties: Record<string, unknown>;
      required?: string[];
    };
  };
}

export interface CompletionRequest {
  model: string;
  messages: Message[];
  tools?: ToolDefinition[];
  tool_choice?: "auto" | "none" | { type: "function"; function: { name: string } };
  stream?: boolean;
  temperature?: number;
  max_tokens?: number;
}

export interface CompletionResponse {
  id: string;
  created: number;
  choices: Array<{
    index: number;
    finish_reason: string | null;
    message?: Message;
    delta?: Partial<Message>;
  }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

export interface StreamEvent {
  type: "content" | "thinking" | "tool_call" | "done" | "error";
  content?: string;
  toolCall?: ToolCall;
  error?: string;
  response?: CompletionResponse;
}

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
}

// ============================================================================
// Provider Types
// ============================================================================

export type ProviderType = "openai" | "anthropic" | "copilot" | "ollama" | "minimax";

/** Built-in provider names (recognized without a `type` field) */
export const BUILTIN_PROVIDERS: readonly ProviderType[] = ["openai", "anthropic", "copilot", "ollama", "minimax"];

export interface ProviderConfig {
  /**
   * Base provider type. When set, this entry is a *custom* provider that
   * inherits the API logic of `type` (e.g., "openai", "anthropic") but
   * overrides base_url, api_key(s), and models.
   * Built-in providers (openai, anthropic, copilot, ollama, minimax) do not need
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
  command: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string; // For HTTP transport
  transport?: "stdio" | "http";
}

export interface Config {
  /**
   * Provider configurations.
   * Built-in keys: "openai", "anthropic", "copilot", "ollama", "minimax".
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
  mcp_servers?: Record<string, MCPServerConfig>;
}
