/**
 * Provider Factory
 *
 * Creates LLM provider instances based on configuration.
 */

import type { LLMProvider, ProviderType, CompletionRequest, CompletionResponse, StreamEvent } from "./providers";
import {
  getSelectedProvider,
  getProviderConfig,
  getModelForProvider,
  getApiKeyForProvider,
  getBaseUrlForProvider,
  getCopilotToken,
} from "./provider-config";
import { CopilotClient } from "./client";

// ============================================================================
// Provider Factory
// ============================================================================

/**
 * Create a provider instance based on the selected provider type
 */
export function createProvider(providerType?: ProviderType): LLMProvider {
  const selectedType = providerType || getSelectedProvider();

  switch (selectedType) {
    case "openai":
      return createOpenAIProvider();
    case "anthropic":
      return createAnthropicProvider();
    case "copilot":
      return createCopilotProvider();
    default:
      // Default to anthropic
      return createAnthropicProvider();
  }
}

/**
 * Create OpenAI-compatible provider
 */
function createOpenAIProvider(): LLMProvider {
  const baseUrl = getBaseUrlForProvider("openai") || "https://api.openai.com/v1";
  const apiKey = getApiKeyForProvider("openai");
  const model = getModelForProvider("openai");

  return new OpenAIProvider({
    baseUrl,
    apiKey: apiKey || "",
    model,
  });
}

/**
 * Create Anthropic-compatible provider
 */
function createAnthropicProvider(): LLMProvider {
  const baseUrl = getBaseUrlForProvider("anthropic") || "https://api.anthropic.com";
  const apiKey = getApiKeyForProvider("anthropic");
  const model = getModelForProvider("anthropic");

  return new AnthropicProvider({
    baseUrl,
    apiKey: apiKey || "",
    model,
  });
}

/**
 * Create Copilot provider
 */
function createCopilotProvider(): LLMProvider {
  const token = getCopilotToken();
  const model = getModelForProvider("copilot");
  const baseUrl = getBaseUrlForProvider("copilot") || "https://api.githubcopilot.com";

  return new CopilotClient(token || "", { model, baseUrl });
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
    const response = await fetch(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        ...request,
        stream: false,
      }),
    });

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

    try {
      while (true) {
        if (signal?.aborted) {
          yield { type: "error", error: "Request aborted" };
          break;
        }

        const { done, value } = await reader.read();
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
  private baseUrl: string;
  private apiKey: string;

  constructor(options: OpenAIProviderOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, "");
    this.apiKey = options.apiKey;
    this.model = options.model;
  }

  async complete(request: CompletionRequest): Promise<CompletionResponse> {
    const anthropicRequest = this.toAnthropicRequest(request);

    const response = await fetch(`${this.baseUrl}/v1/messages`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": this.apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify(anthropicRequest),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Anthropic API error: ${response.status} - ${error}`);
    }

    return this.fromAnthropicResponse(await response.json(), request.model);
  }

  async *stream(request: CompletionRequest, signal?: AbortSignal): AsyncGenerator<StreamEvent> {
    const anthropicRequest = this.toAnthropicRequest(request, true);

    const response = await fetch(`${this.baseUrl}/v1/messages`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": this.apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify(anthropicRequest),
    });

    if (!response.ok) {
      const error = await response.text();
      yield { type: "error", error: `Anthropic API error: ${response.status} - ${error}` };
      return;
    }

    if (!response.body) {
      yield { type: "error", error: "No response body" };
      return;
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let currentContent = "";
    const toolCallBuffer: Map<number, { id: string; name: string; arguments: string }> = new Map();

    try {
      while (true) {
        if (signal?.aborted) {
          yield { type: "error", error: "Request aborted" };
          break;
        }

        const { done, value } = await reader.read();
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
