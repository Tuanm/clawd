/**
 * Shared API types used by both client.ts and providers.ts.
 */

// ============================================================================
// Shared Message / Tool Types
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
  /** If true, this tool only reads state and can be executed in parallel with other read-only tools */
  readOnly?: boolean;
  /**
   * Internal hint: place an Anthropic `cache_control` breakpoint on this tool. Only the
   * last alwaysInclude tool is marked, giving a small stable prefix that survives
   * warmup → steady-state → re-expansion transitions. The factory also unconditionally
   * places a breakpoint on the last tool overall, so this gives a 2-breakpoint design
   * (last-alwaysInclude + last-overall). Stripped before sending to providers.
   */
  cacheBreakpoint?: boolean;
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
