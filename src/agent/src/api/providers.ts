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
  stream(request: CompletionRequest, signal?: AbortSignal): AsyncGenerator<StreamEvent>;

  /**
   * Close any open connections
   */
  close(): void;
}

// ============================================================================
// Provider Types
// ============================================================================

export type ProviderType = "openai" | "anthropic" | "copilot" | "ollama";

export interface ProviderConfig {
  // Common
  api_key?: string;
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

export interface CopilotProviderConfig {
  token?: string;
}

export interface OllamaProviderConfig {
  api_key?: string;
  base_url?: string;
  models?: {
    default?: string;
    [key: string]: string | undefined;
  };
}

export interface Config {
  providers: {
    anthropic?: ProviderConfig;
    openai?: ProviderConfig;
    copilot?: CopilotProviderConfig;
    ollama?: OllamaProviderConfig;
  };
}
