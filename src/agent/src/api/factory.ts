/**
 * Provider Factory
 *
 * Creates LLM provider instances based on configuration.
 */

import type { LLMProvider, ProviderType, CompletionRequest, CompletionResponse, StreamEvent } from "./providers";
import { isDebugEnabled } from "../utils/debug";
import {
  getSelectedProvider,
  getProviderConfig,
  getModelForProvider,
  getApiKeyForProvider,
  getBaseUrlForProvider,
  getCopilotToken,
} from "./provider-config";
import { CopilotClient } from "./client";

// Stream idle timeout (abort if no data for this duration)
const STREAM_IDLE_TIMEOUT_MS = 60_000;

/** Race reader.read() against an idle timeout; resets on every chunk. */
function readWithIdleTimeout(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal?: AbortSignal,
  idleMs = STREAM_IDLE_TIMEOUT_MS,
): () => Promise<ReadableStreamReadResult<Uint8Array>> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const clear = () => {
    if (timer) clearTimeout(timer);
    timer = null;
  };
  return async () => {
    clear();
    return new Promise<ReadableStreamReadResult<Uint8Array>>((resolve, reject) => {
      timer = setTimeout(() => {
        reject(new Error(`Stream idle timeout after ${idleMs}ms`));
      }, idleMs);
      reader.read().then(
        (result) => {
          clear();
          resolve(result);
        },
        (err) => {
          clear();
          reject(err);
        },
      );
    });
  };
}

// ============================================================================
// Provider Factory
// ============================================================================

/**
 * Create a provider instance based on the selected provider type
 */
export function createProvider(providerType?: ProviderType, modelOverride?: string): LLMProvider {
  const selectedType = providerType || getSelectedProvider();
  // Resolve model override: "default" or empty means no override (use config.json)
  const effectiveModelOverride = modelOverride && modelOverride !== "default" ? modelOverride : undefined;

  const provider = (() => {
    switch (selectedType) {
      case "openai":
        return createOpenAIProvider(effectiveModelOverride);
      case "anthropic":
        return createAnthropicProvider(effectiveModelOverride);
      case "copilot":
        return createCopilotProvider(effectiveModelOverride);
      case "ollama":
        return createOllamaProvider(effectiveModelOverride);
      default:
        return createCopilotProvider(effectiveModelOverride);
    }
  })();

  console.log(
    `[Provider] type=${selectedType}, model=${(provider as any).model}${effectiveModelOverride ? ` (override from agent config)` : ""}`,
  );
  return provider;
}

/**
 * Create OpenAI-compatible provider
 */
function createOpenAIProvider(modelOverride?: string): LLMProvider {
  const baseUrl = getBaseUrlForProvider("openai") || "https://api.openai.com/v1";
  const apiKey = getApiKeyForProvider("openai");
  const model = modelOverride || getModelForProvider("openai");

  return new OpenAIProvider({
    baseUrl,
    apiKey: apiKey || "",
    model,
  });
}

/**
 * Create Anthropic-compatible provider
 */
function createAnthropicProvider(modelOverride?: string): LLMProvider {
  const baseUrl = getBaseUrlForProvider("anthropic") || "https://api.anthropic.com";
  const apiKey = getApiKeyForProvider("anthropic");
  const model = modelOverride || getModelForProvider("anthropic");

  return new AnthropicProvider({
    baseUrl,
    apiKey: apiKey || "",
    model,
  });
}

/**
 * Create Copilot provider
 */
function createCopilotProvider(modelOverride?: string): LLMProvider {
  const token = getCopilotToken();
  const model = modelOverride || getModelForProvider("copilot");
  const baseUrl = getBaseUrlForProvider("copilot") || "https://api.githubcopilot.com";

  return new CopilotClient(token || "", { model, baseUrl });
}

/**
 * Create Ollama provider (uses Anthropic-compatible API)
 */
function createOllamaProvider(modelOverride?: string): LLMProvider {
  const baseUrl = getBaseUrlForProvider("ollama") || "https://ollama.com";
  const apiKey = getApiKeyForProvider("ollama");
  const model = modelOverride || getModelForProvider("ollama");

  return new OllamaProvider({ baseUrl, apiKey: apiKey || "", model });
}

// ============================================================================
// OpenAI Provider Implementation
// ============================================================================

interface OpenAIProviderOptions {
  baseUrl: string;
  apiKey: string;
  model: string;
}

class OpenAIProvider implements LLMProvider {
  readonly model: string;
  private baseUrl: string;
  private apiKey: string;

  constructor(options: OpenAIProviderOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, "");
    this.apiKey = options.apiKey;
    this.model = options.model;
  }

  async complete(request: CompletionRequest): Promise<CompletionResponse> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 120000);
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          ...request,
          stream: false,
        }),
        signal: ctrl.signal,
      });
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`OpenAI API error: ${response.status} - ${error}`);
    }

    return response.json();
  }

  async *stream(request: CompletionRequest, signal?: AbortSignal): AsyncGenerator<StreamEvent> {
    const response = await fetch(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        ...request,
        stream: true,
      }),
      signal,
    });

    if (!response.ok) {
      const error = await response.text();
      yield { type: "error", error: `OpenAI API error: ${response.status} - ${error}` };
      return;
    }

    if (!response.body) {
      yield { type: "error", error: "No response body" };
      return;
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    const toolCallBuffer: Map<number, any> = new Map();
    const readNext = readWithIdleTimeout(reader, signal);

    try {
      while (true) {
        if (signal?.aborted) {
          yield { type: "error", error: "Request aborted" };
          break;
        }

        const { done, value } = await readNext();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          const data = line.slice(6).trim();
          if (data === "[DONE]") {
            yield { type: "done" };
            continue;
          }

          try {
            const json = JSON.parse(data);
            const choice = json.choices?.[0];

            if (!choice) continue;

            if (choice.delta?.content) {
              yield { type: "content", content: choice.delta.content };
            }

            if (choice.delta?.tool_calls) {
              for (const tc of choice.delta.tool_calls) {
                const idx = tc.index ?? 0;
                let existing = toolCallBuffer.get(idx);

                if (!existing) {
                  existing = {
                    id: tc.id || "",
                    type: "function",
                    function: { name: "", arguments: "" },
                  };
                  toolCallBuffer.set(idx, existing);
                }

                if (tc.id) existing.id = tc.id;
                if (tc.function?.name) existing.function.name = tc.function.name;
                if (tc.function?.arguments) existing.function.arguments += tc.function.arguments;
              }
            }

            if (choice.finish_reason === "tool_calls") {
              for (const tc of toolCallBuffer.values()) {
                yield { type: "tool_call", toolCall: tc };
              }
              toolCallBuffer.clear();
            }

            if (choice.finish_reason === "stop") {
              yield { type: "done", response: json };
            }
          } catch {
            // Skip parse errors
          }
        }
      }
    } finally {
      reader.releaseLock();
    }
  }

  close(): void {
    // No connection to close for HTTP/1.1 fetch
  }
}

// ============================================================================
// Anthropic Provider Implementation
// ============================================================================

class AnthropicProvider implements LLMProvider {
  readonly model: string;
  protected baseUrl: string;
  protected apiKey: string;

  constructor(options: OpenAIProviderOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, "");
    this.apiKey = options.apiKey;
    this.model = options.model;
  }

  protected getHeaders(): Record<string, string> {
    return {
      "Content-Type": "application/json",
      "x-api-key": this.apiKey,
      "anthropic-version": "2023-06-01",
    };
  }

  protected getEndpoint(): string {
    return `${this.baseUrl}/v1/messages`;
  }

  async complete(request: CompletionRequest): Promise<CompletionResponse> {
    const anthropicRequest = this.toAnthropicRequest(request);

    // Debug logging
    if (isDebugEnabled()) {
      console.log(
        `[Provider] Request:`,
        JSON.stringify({
          model: anthropicRequest.model,
          messages: anthropicRequest.messages?.length,
          tools: anthropicRequest.tools?.length,
        }),
      );
    }

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 120000);
    let response: Response;
    try {
      response = await fetch(this.getEndpoint(), {
        method: "POST",
        headers: this.getHeaders(),
        body: JSON.stringify(anthropicRequest),
        signal: ctrl.signal,
      });
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Anthropic API error: ${response.status} - ${error}`);
    }

    const responseJson = await response.json();

    // Debug logging
    if (isDebugEnabled()) {
      console.log(
        `[Provider] Response:`,
        JSON.stringify({
          id: responseJson.id,
          stop_reason: responseJson.stop_reason,
          content_blocks: responseJson.content?.length,
        }),
      );
    }

    return this.fromAnthropicResponse(responseJson, request.model);
  }

  async *stream(request: CompletionRequest, signal?: AbortSignal): AsyncGenerator<StreamEvent> {
    const anthropicRequest = this.toAnthropicRequest(request, true);

    // Log the request
    // Log request info
    console.log(
      `[Provider] Request: model=${anthropicRequest.model}, messages=${anthropicRequest.messages?.length}, tools=${anthropicRequest.tools?.length}`,
    );

    const response = await fetch(this.getEndpoint(), {
      method: "POST",
      headers: this.getHeaders(),
      body: JSON.stringify(anthropicRequest),
      signal,
    });

    if (!response.ok) {
      const error = await response.text();
      // Log error
      yield { type: "error", error: `Anthropic API error: ${response.status} - ${error}` };
      return;
    }

    if (!response.body) {
      console.log(`[Provider] No response body`);
      yield { type: "error", error: "No response body" };
      return;
    }

    // Response started

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let currentContent = "";
    const toolCallBuffer: Map<number, { id: string; name: string; arguments: string }> = new Map();
    const readNext = readWithIdleTimeout(reader, signal);

    try {
      while (true) {
        if (signal?.aborted) {
          yield { type: "error", error: "Request aborted" };
          break;
        }

        const { done, value } = await readNext();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          const data = line.slice(6).trim();
          if (data === "[DONE]") {
            yield { type: "done" };
            continue;
          }

          try {
            const event = JSON.parse(data);

            // Handle text content
            if (event.type === "content_block_start" && event.content_block?.type === "text") {
              currentContent = "";
            } else if (event.type === "content_block_delta" && event.delta?.type === "text_delta" && event.delta.text) {
              currentContent += event.delta.text;
              yield { type: "content", content: event.delta.text };
            }
            // Handle native Anthropic tool_use blocks
            else if (event.type === "content_block_start" && event.content_block?.type === "tool_use") {
              const idx = event.index;
              toolCallBuffer.set(idx, {
                id: event.content_block.id,
                name: event.content_block.name,
                arguments: "",
              });
            } else if (event.type === "content_block_delta" && event.delta?.type === "input_json_delta") {
              const idx = event.index;
              const tc = toolCallBuffer.get(idx);
              if (tc) {
                tc.arguments += event.delta.partial_json || "";
              }
            } else if (event.type === "content_block_stop" && event.index !== undefined) {
              const idx = event.index;
              const tc = toolCallBuffer.get(idx);
              if (tc && tc.name) {
                // Tool call from Ollama
                yield {
                  type: "tool_call",
                  toolCall: {
                    id: tc.id,
                    type: "function",
                    function: {
                      name: tc.name,
                      arguments: tc.arguments,
                    },
                  },
                };
              }
              toolCallBuffer.delete(idx);
            } else if (event.type === "message_stop") {
              yield { type: "done" };
            }
          } catch {
            // Skip parse errors
          }
        }
      }
    } finally {
      reader.releaseLock();
    }
  }

  close(): void {
    // No connection to close
  }

  private toAnthropicRequest(request: CompletionRequest, stream = false): any {
    // Extract system message content
    let systemContent: string | undefined;
    const filteredMessages = request.messages
      .filter((msg) => {
        if (msg.role === "system") {
          systemContent = msg.content;
          return false; // Don't include system in messages array
        }
        return true;
      })
      .map((msg) => {
        // Handle tool results - convert to Anthropic format
        if (msg.role === "tool") {
          return {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: msg.tool_call_id,
                content: msg.content,
              },
            ],
          };
        }

        // Handle assistant messages with tool calls
        if (msg.role === "assistant" && msg.tool_calls) {
          const content: any[] = [];
          if (msg.content) {
            content.push({ type: "text", text: msg.content });
          }
          for (const tc of msg.tool_calls) {
            content.push({
              type: "tool_use",
              id: tc.id,
              name: tc.function.name,
              input: JSON.parse(tc.function.arguments || "{}"),
            });
          }
          return { role: "assistant", content };
        }

        return {
          role: msg.role === "assistant" ? "assistant" : "user",
          content: msg.content,
        };
      });

    const messages = filteredMessages;

    // Convert tools to Anthropic format
    let tools: any[] | undefined;
    if (request.tools && request.tools.length > 0) {
      tools = request.tools.map((tool) => ({
        name: tool.function.name,
        description: tool.function.description,
        input_schema: tool.function.parameters,
      }));
    }

    return {
      model: request.model,
      messages,
      max_tokens: request.max_tokens || 4096,
      stream: stream || undefined,
      temperature: request.temperature,
      tools,
      ...(systemContent && { system: systemContent }),
    };
  }

  private fromAnthropicResponse(response: any, model: string): any {
    const contentBlocks = response.content || [];
    let messageContent: string | null = null;
    let toolCalls: any[] | undefined;

    for (const block of contentBlocks) {
      if (block.type === "text" && block.text) {
        messageContent = (messageContent || "") + block.text;
      } else if (block.type === "tool_use") {
        if (!toolCalls) toolCalls = [];
        toolCalls.push({
          id: block.id,
          type: "function",
          function: {
            name: block.name,
            arguments: JSON.stringify(block.input || {}),
          },
        });
      }
    }

    // Determine finish reason
    let finishReason = response.stop_reason || "stop";
    if (toolCalls && toolCalls.length > 0) {
      finishReason = "tool_calls";
    }

    return {
      id: response.id,
      created: Date.now(),
      choices: [
        {
          index: 0,
          finish_reason: finishReason,
          message: {
            role: "assistant",
            content: messageContent,
            tool_calls: toolCalls,
          },
        },
      ],
      usage: {
        prompt_tokens: response.usage?.input_tokens || 0,
        completion_tokens: response.usage?.output_tokens || 0,
        total_tokens: (response.usage?.input_tokens || 0) + (response.usage?.output_tokens || 0),
      },
    };
  }
}

// ============================================================================
// Ollama Provider (native /api/chat endpoint)
// ============================================================================

class OllamaProvider implements LLMProvider {
  readonly model: string;
  private baseUrl: string;
  private apiKey: string;

  constructor(options: OpenAIProviderOptions) {
    // Use /api/chat endpoint, not /v1/messages
    this.baseUrl = options.baseUrl.replace(/\/$/, "").replace("/v1", "");
    if (!this.baseUrl.includes("ollama.com")) {
      this.baseUrl = "http://localhost:11434";
    }
    this.apiKey = options.apiKey;
    this.model = options.model;
  }

  protected getHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    // Ollama cloud uses Bearer token
    if (this.apiKey) {
      headers["Authorization"] = `Bearer ${this.apiKey}`;
    }
    return headers;
  }

  protected getEndpoint(): string {
    return `${this.baseUrl}/api/chat`;
  }

  private toOllamaRequest(request: CompletionRequest, stream = false): any {
    // Extract system message content (Ollama supports role: "system" in messages)
    let systemContent: string | undefined;
    const messages = request.messages
      .filter((msg) => {
        if (msg.role === "system") {
          systemContent = msg.content || "";
          return false; // Don't include system in messages array
        }
        return true;
      })
      .map((msg) => {
        // Handle tool results - Ollama uses "tool_name" not "tool_call_id"
        if (msg.role === "tool") {
          return {
            role: "tool",
            tool_name: msg.tool_call_id || "unknown", // Extract tool name from tool_call_id
            content: msg.content,
          };
        }

        // Handle assistant messages with tool calls - Ollama uses "index" not "id"
        // Convert index to id so the agent can match tool results
        if (msg.role === "assistant" && msg.tool_calls) {
          return {
            role: "assistant",
            content: msg.content,
            tool_calls: msg.tool_calls.map((tc, idx) => ({
              id: String(idx), // Convert index to string id for matching tool results
              index: idx,
              function: {
                name: tc.function.name,
                arguments: (() => {
                  const args = tc.function.arguments;
                  // Always ensure arguments is a valid JSON string
                  if (args === null || args === undefined) {
                    return "{}";
                  }
                  if (typeof args === "string") {
                    // Try to parse and re-stringify to ensure valid JSON
                    try {
                      const parsed = JSON.parse(args);
                      return JSON.stringify(parsed);
                    } catch {
                      // If not valid JSON, wrap it as a string value
                      return JSON.stringify({ _raw: args });
                    }
                  }
                  // It's an object - stringify it
                  return JSON.stringify(args);
                })(),
              },
            })),
          };
        }

        return {
          role: msg.role === "system" ? "system" : msg.role,
          content: msg.content,
        };
      });

    // Add tool instruction to user message - this is the most reliable way to ensure tool use
    const userMsgs = messages.filter((m: any) => m.role === "user");
    for (const userMsg of userMsgs) {
      if (userMsg.content && userMsg.content.includes("# New Messages on Channel")) {
        // Extract just the message text
        const newMessagesMatch = userMsg.content.match(
          /# New Messages on Channel "[^"]+"\s*\(from ts [^)]+\)\s*\n\n([\s\S]*?)(?=\n---|\n# SYSTEM INSTRUCTIONS)/i,
        );
        if (newMessagesMatch && newMessagesMatch[1]) {
          const msgMatch = newMessagesMatch[1].trim().match(/\] human: (.+)$/);
          const actualMsg = msgMatch ? msgMatch[1].trim() : newMessagesMatch[1].trim();
          // Prepend instruction to use tools - this is more effective than just system prompt
          userMsg.content = `IMPORTANT: You MUST respond using the chat_send_message tool. Never write plain text. Tool required. User message: ${actualMsg}`;
        }
      }
    }

    // Convert tools to Ollama format (use "parameters" not "input_schema")
    let tools: any[] | undefined;
    if (request.tools && request.tools.length > 0) {
      tools = request.tools.map((tool) => ({
        type: "function",
        function: {
          name: tool.function.name,
          description: tool.function.description,
          parameters: tool.function.parameters,
        },
      }));
    }

    // Add a strong tool usage instruction for Ollama as a separate system message
    // This is more reliable than mixing with user message
    const toolInstruction = `CRITICAL: You MUST call BOTH tools in sequence:
1. chat_send_message(channel="...", text="...", agent_id="...")
2. chat_mark_processed(channel="...", timestamp="...", agent_id="...")

Example for channel "demo" and timestamp "123":
- First call: chat_send_message(channel="demo", text="Hello!", agent_id="Tuan")
- Then call: chat_mark_processed(channel="demo", timestamp="123", agent_id="Tuan")

NEVER skip step 2! If you skip, the message will be processed infinitely!`;
    if (systemContent) {
      messages.unshift({
        role: "system",
        content: systemContent + "\n\n" + toolInstruction,
      });
    } else {
      messages.unshift({
        role: "system",
        content: toolInstruction,
      });
    }

    const result = {
      model: request.model,
      messages,
      tools,
      stream,
      options: {
        temperature: 0.1, // Lower temperature for more predictable tool use
        num_ctx: 8192, // Ensure enough context
      },
    };

    return result;
  }

  private fromOllamaResponse(response: any): CompletionResponse {
    const msg = response.message || {};
    const toolCalls = (msg.tool_calls || []).map((tc: any) => ({
      id: tc.id || `call_${Date.now()}`,
      type: "function",
      function: {
        name: tc.function?.name || "",
        arguments:
          typeof tc.function?.arguments === "string"
            ? tc.function.arguments
            : JSON.stringify(tc.function?.arguments || {}),
      },
    }));

    const finishReason = response.done_reason || (toolCalls.length > 0 ? "tool_calls" : "stop");

    return {
      id: response.id || `ollama-${Date.now()}`,
      created: Date.now(),
      choices: [
        {
          index: 0,
          finish_reason: finishReason,
          message: {
            role: "assistant",
            content: msg.content || "",
            tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
          },
        },
      ],
      usage: {
        prompt_tokens: response.prompt_eval_count || 0,
        completion_tokens: response.eval_count || 0,
        total_tokens: (response.prompt_eval_count || 0) + (response.eval_count || 0),
      },
    };
  }

  async complete(request: CompletionRequest): Promise<CompletionResponse> {
    const ollamaRequest = this.toOllamaRequest(request, false);

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 120000);
    let response: Response;
    try {
      response = await fetch(this.getEndpoint(), {
        method: "POST",
        headers: this.getHeaders(),
        body: JSON.stringify(ollamaRequest),
        signal: ctrl.signal,
      });
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Ollama API error: ${response.status} - ${error}`);
    }

    const responseJson = await response.json();
    return this.fromOllamaResponse(responseJson);
  }

  async *stream(request: CompletionRequest, signal?: AbortSignal): AsyncGenerator<StreamEvent> {
    const ollamaRequest = this.toOllamaRequest(request, true);

    const response = await fetch(this.getEndpoint(), {
      method: "POST",
      headers: this.getHeaders(),
      body: JSON.stringify(ollamaRequest),
      signal,
    });

    if (!response.ok) {
      const error = await response.text();
      yield { type: "error", error: `Ollama API error: ${response.status} - ${error}` };
      return;
    }

    if (!response.body) {
      yield { type: "error", error: "No response body" };
      return;
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    const toolCallBuffer: Map<number, { name: string; arguments: string }> = new Map();
    const readNext = readWithIdleTimeout(reader, signal);

    try {
      while (true) {
        if (signal?.aborted) {
          yield { type: "error", error: "Request aborted" };
          break;
        }

        const { done, value } = await readNext();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          if (!line.trim()) continue;

          // Handle both "data: " prefix (SSE) and raw JSON (NDJSON)
          let data = line.trim();
          if (data.startsWith("data: ")) {
            data = data.slice(6).trim();
          }
          if (data === "[DONE]") {
            yield { type: "done" };
            continue;
          }

          try {
            const event = JSON.parse(data);

            // Handle thinking content (extended thinking)
            if (event.message?.thinking) {
              // Could yield thinking events if needed
            }

            // Handle text content
            if (event.message?.content) {
              yield { type: "content", content: event.message.content };
            }

            // Handle tool calls - check even when content is empty
            if (event.message?.tool_calls && event.message.tool_calls.length > 0) {
              for (const tc of event.message.tool_calls) {
                const idx = tc.index ?? 0;
                const existing = toolCallBuffer.get(idx);
                const argsValue = tc.function?.arguments;

                if (!existing) {
                  // First time seeing this tool call
                  const argsStr = typeof argsValue === "string" ? argsValue : JSON.stringify(argsValue || {});
                  toolCallBuffer.set(idx, {
                    name: tc.function?.name || "",
                    arguments: argsStr,
                  });
                } else {
                  // Accumulate arguments
                  if (argsValue) {
                    const newArgs = typeof argsValue === "string" ? argsValue : JSON.stringify(argsValue);
                    existing.arguments += newArgs;
                  }
                }
              }
            }

            // Check if done
            if (event.done) {
              // Yield any pending tool calls
              for (const [id, tc] of toolCallBuffer.entries()) {
                if (tc.name) {
                  yield {
                    type: "tool_call",
                    toolCall: {
                      id,
                      type: "function",
                      function: {
                        name: tc.name,
                        arguments: tc.arguments,
                      },
                    },
                  };
                }
              }
              toolCallBuffer.clear();
              yield { type: "done" };
            }
          } catch {
            // Skip parse errors
          }
        }
      }
    } finally {
      reader.releaseLock();
    }
  }

  close(): void {
    // No connection to close for HTTP/1.1 fetch
  }
}
