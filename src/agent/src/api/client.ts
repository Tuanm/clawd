/**
 * Copilot API Client with HTTP/2 and Streaming Support
 */

import http2 from "node:http2";
import { EventEmitter } from "node:events";
import { API_URL } from "./config";

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
// Configuration
// ============================================================================

const BASE_HEADERS = {
  "Content-Type": "application/json",
  Accept: "application/json",
  "X-Interaction-Type": "conversation-agent",
  "Openai-Intent": "conversation-agent",
  "X-Initiator": "agent",
  "X-GitHub-Api-Version": "2025-05-01",
  "Copilot-Integration-Id": "copilot-developer-cli",
  "User-Agent": "Claw'd/1.0.0",
};

// ============================================================================
// Debug Logging
// ============================================================================

import { isDebugEnabled, setDebug as setGlobalDebug } from "../utils/debug";

// Local override for API-specific debug (can be set independently)
let localDebugEnabled: boolean | null = null;

function isApiDebugEnabled(): boolean {
  // If local override is set, use it; otherwise use global debug state
  return localDebugEnabled ?? isDebugEnabled();
}

function logRequest(request: CompletionRequest) {
  if (!isApiDebugEnabled()) return;
  const summary = {
    model: request.model,
    messages: request.messages.length,
    tools: request.tools?.length || 0,
    stream: request.stream,
  };
  console.log(`\x1b[35m[API Request]\x1b[0m ${JSON.stringify(summary)}`);
  // Log last 2 messages for context
  const lastMessages = request.messages.slice(-2).map((m) => ({
    role: m.role,
    content:
      typeof m.content === "string" ? m.content.slice(0, 100) + (m.content.length > 100 ? "..." : "") : m.content,
    tool_calls: m.tool_calls?.length,
    tool_call_id: m.tool_call_id,
  }));
  console.log(`\x1b[35m[API Request] Last messages:\x1b[0m`, JSON.stringify(lastMessages, null, 2));
}

function logResponse(status: number, body?: string) {
  if (!isApiDebugEnabled()) return;
  if (status === 200) {
    console.log(`\x1b[32m[API Response]\x1b[0m ${status} OK`);
  } else {
    console.log(`\x1b[31m[API Response]\x1b[0m ${status} ${body?.slice(0, 500)}`);
  }
}

function logStreamEvent(event: StreamEvent) {
  if (!isApiDebugEnabled()) return;
  if (event.type === "content" && event.content) {
    // Don't log every token, just periodically
    return;
  }
  if (event.type === "tool_call") {
    console.log(`\x1b[35m[API Stream]\x1b[0m tool_call: ${event.toolCall?.function.name}`);
  } else if (event.type === "done") {
    console.log(`\x1b[35m[API Stream]\x1b[0m done`);
  } else if (event.type === "error") {
    console.log(`\x1b[31m[API Stream]\x1b[0m error: ${event.error}`);
  }
}

// ============================================================================
// Client
// ============================================================================

// Rate limit handling constants
const RATE_LIMIT_MAX_RETRIES = 5;
const RATE_LIMIT_BASE_DELAY_MS = 5000; // Start with 5 seconds
const RATE_LIMIT_MAX_DELAY_MS = 60000; // Max 60 seconds

// Timeout constants
const CONNECT_TIMEOUT_MS = 10_000; // 10s to establish HTTP/2 connection
const REQUEST_TIMEOUT_MS = 120_000; // 120s for non-streaming requests (LLM can be slow)
const STREAM_IDLE_TIMEOUT_MS = 60_000; // 60s idle timeout for streaming (no data received)

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class CopilotClient extends EventEmitter {
  private token: string;
  private client: http2.ClientHttp2Session | null = null;

  // Enable debug logging: CopilotClient.debug = true or use --debug flag
  static set debug(value: boolean) {
    localDebugEnabled = value;
  }
  static get debug(): boolean {
    return isApiDebugEnabled();
  }

  constructor(token: string) {
    super();
    this.token = token;
  }

  private getClient(): Promise<http2.ClientHttp2Session> {
    return new Promise((resolve, reject) => {
      if (this.client && !this.client.destroyed) {
        resolve(this.client);
        return;
      }

      const timer = setTimeout(() => {
        reject(new Error(`HTTP/2 connection timeout after ${CONNECT_TIMEOUT_MS}ms`));
        this.client?.destroy();
        this.client = null;
      }, CONNECT_TIMEOUT_MS);

      this.client = http2.connect(API_URL);

      this.client.on("connect", () => {
        clearTimeout(timer);
        resolve(this.client!);
      });
      this.client.on("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });
      this.client.on("close", () => {
        this.client = null;
      });
    });
  }

  async complete(request: CompletionRequest): Promise<CompletionResponse> {
    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= RATE_LIMIT_MAX_RETRIES; attempt++) {
      try {
        return await this._completeOnce(request);
      } catch (error: any) {
        if (error.message?.includes("429")) {
          lastError = error;
          const delay = Math.min(RATE_LIMIT_BASE_DELAY_MS * 2 ** attempt, RATE_LIMIT_MAX_DELAY_MS);
          console.error(
            `[API] Rate limited (429), sleeping ${delay / 1000}s before retry ${attempt + 1}/${RATE_LIMIT_MAX_RETRIES}`,
          );
          await sleep(delay);
          continue;
        }
        throw error;
      }
    }

    throw lastError || new Error("Rate limit retries exhausted");
  }

  private async _completeOnce(request: CompletionRequest): Promise<CompletionResponse> {
    const client = await this.getClient();
    logRequest(request);

    return new Promise((resolve, reject) => {
      const headers = {
        ":method": "POST",
        ":path": "/v1/chat/completions",
        Authorization: `Bearer ${this.token}`,
        "X-Interaction-Id": crypto.randomUUID(),
        ...BASE_HEADERS,
      };

      const body = JSON.stringify({ ...request, stream: false });
      const req = client.request(headers);

      // Request timeout for non-streaming requests
      const timer = setTimeout(() => {
        req.close();
        reject(new Error(`Request timeout after ${REQUEST_TIMEOUT_MS}ms`));
      }, REQUEST_TIMEOUT_MS);

      let data = "";

      req.on("response", (headers) => {
        const status = headers[":status"] as number;
        if (status !== 200) {
          req.on("data", (chunk) => (data += chunk));
          req.on("end", () => {
            clearTimeout(timer);
            logResponse(status, data);
            reject(new Error(`API error ${status}: ${data}`));
          });
          return;
        }
        logResponse(status);
      });

      req.on("data", (chunk) => (data += chunk));
      req.on("end", () => {
        clearTimeout(timer);
        try {
          resolve(JSON.parse(data));
        } catch (_e) {
          reject(new Error(`Failed to parse response: ${data}`));
        }
      });
      req.on("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });

      req.write(body);
      req.end();
    });
  }

  async *stream(request: CompletionRequest, signal?: AbortSignal): AsyncGenerator<StreamEvent> {
    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= RATE_LIMIT_MAX_RETRIES; attempt++) {
      try {
        // Try to stream, yield all events
        for await (const event of this._streamOnce(request, signal)) {
          yield event;
        }
        return; // Success, exit retry loop
      } catch (error: any) {
        if (error.message?.includes("429")) {
          lastError = error;
          const delay = Math.min(RATE_LIMIT_BASE_DELAY_MS * 2 ** attempt, RATE_LIMIT_MAX_DELAY_MS);
          console.error(
            `[API] Rate limited (429), sleeping ${delay / 1000}s before retry ${attempt + 1}/${RATE_LIMIT_MAX_RETRIES}`,
          );
          await sleep(delay);
          continue;
        }
        throw error;
      }
    }

    throw lastError || new Error("Rate limit retries exhausted");
  }

  private async *_streamOnce(request: CompletionRequest, signal?: AbortSignal): AsyncGenerator<StreamEvent> {
    const client = await this.getClient();
    logRequest(request);

    const headers = {
      ":method": "POST",
      ":path": "/v1/chat/completions",
      Authorization: `Bearer ${this.token}`,
      "X-Interaction-Id": crypto.randomUUID(),
      ...BASE_HEADERS,
    };

    const body = JSON.stringify({ ...request, stream: true });
    const req = client.request(headers);

    // Create a queue for streaming events
    const queue: StreamEvent[] = [];
    let done = false;
    let error: Error | null = null;
    let resolver: (() => void) | null = null;
    let aborted = false;

    // Idle timeout: if no data received for STREAM_IDLE_TIMEOUT_MS, abort
    let idleTimer: ReturnType<typeof setTimeout> | null = null;
    const resetIdleTimer = () => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        if (!done && !aborted) {
          error = new Error(`Stream idle timeout after ${STREAM_IDLE_TIMEOUT_MS}ms`);
          req.close();
          resolver?.();
        }
      }, STREAM_IDLE_TIMEOUT_MS);
    };
    resetIdleTimer(); // Start initial idle timer (waiting for first data)

    // Handle abort signal
    if (signal) {
      signal.addEventListener(
        "abort",
        () => {
          aborted = true;
          if (idleTimer) clearTimeout(idleTimer);
          req.close();
          resolver?.();
        },
        { once: true },
      );
    }

    const push = (event: StreamEvent) => {
      if (aborted) return;
      logStreamEvent(event);
      queue.push(event);
      resolver?.();
    };

    let buffer = "";
    const currentToolCalls: Map<number, ToolCall> = new Map();
    let errorBody = "";

    req.on("response", (headers) => {
      const status = headers[":status"] as number;
      logResponse(status, status !== 200 ? errorBody : undefined);
      if (status !== 200) {
        // Collect error body before rejecting
        req.on("data", (chunk: Buffer) => {
          errorBody += chunk.toString();
        });
        req.on("end", () => {
          logResponse(status, errorBody);
          error = new Error(`API error ${status}: ${errorBody}`);
          if (idleTimer) clearTimeout(idleTimer);
          resolver?.();
        });
      }
    });

    req.on("data", (chunk: Buffer) => {
      if (aborted) return;
      resetIdleTimer(); // Reset idle timer on every data chunk
      buffer += chunk.toString();

      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;

        const data = line.slice(6).trim();
        if (data === "[DONE]") {
          push({ type: "done" });
          continue;
        }

        try {
          const json: CompletionResponse = JSON.parse(data);
          const choice = json.choices[0];

          if (!choice) continue;

          // Handle content delta
          if (choice.delta?.content) {
            push({ type: "content", content: choice.delta.content });
          }

          // Handle thinking/reasoning delta (Claude extended thinking)
          // Check for thinking content in various possible locations
          const thinking =
            (choice.delta as any)?.thinking ||
            (choice.delta as any)?.reasoning ||
            (choice.delta as any)?.internal_monologue;
          if (thinking) {
            push({ type: "thinking", content: thinking });
          }

          // Handle tool calls delta
          if (choice.delta?.tool_calls) {
            for (const tc of choice.delta.tool_calls) {
              const idx = (tc as any).index ?? 0;
              let existing = currentToolCalls.get(idx);

              if (!existing) {
                existing = {
                  id: tc.id || "",
                  type: "function",
                  function: { name: "", arguments: "" },
                };
                currentToolCalls.set(idx, existing);
              }

              if (tc.id) existing.id = tc.id;
              if (tc.function?.name) existing.function.name = tc.function.name;
              if (tc.function?.arguments) existing.function.arguments += tc.function.arguments;
            }
          }

          // Check for finish
          if (choice.finish_reason === "tool_calls") {
            for (const tc of currentToolCalls.values()) {
              push({ type: "tool_call", toolCall: tc });
            }
            currentToolCalls.clear();
          }

          if (choice.finish_reason === "stop") {
            push({ type: "done", response: json });
          }
        } catch {
          // Ignore parse errors for partial chunks
        }
      }
    });

    req.on("end", () => {
      if (idleTimer) clearTimeout(idleTimer);
      done = true;
      resolver?.();
    });

    req.on("error", (e) => {
      if (idleTimer) clearTimeout(idleTimer);
      if (!aborted) error = e;
      resolver?.();
    });

    req.write(body);
    req.end();

    // Yield events as they come
    while (true) {
      if (aborted) {
        yield { type: "error", error: "Request aborted" };
        break;
      }

      if (queue.length > 0) {
        yield queue.shift()!;
        continue;
      }

      if (done || error) break;

      // Wait for next event
      await new Promise<void>((resolve) => {
        resolver = resolve;
      });
      resolver = null;
    }

    if (error && !aborted) {
      yield { type: "error", error: error.message };
    }
  }

  close() {
    this.client?.close();
    this.client = null;
  }
}

// ============================================================================
// Token Helper
// ============================================================================

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

export function getToken(): string | null {
  // Check environment variables
  if (process.env.COPILOT_GITHUB_TOKEN) return process.env.COPILOT_GITHUB_TOKEN;
  if (process.env.GH_TOKEN) return process.env.GH_TOKEN;
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN;

  // Read from gh CLI config (try multiple locations for cross-platform support)
  const configPaths = [
    join(homedir(), ".config", "gh", "hosts.yml"), // Linux/WSL
    join(homedir(), "Library", "Application Support", "gh", "hosts.yml"), // macOS
    join(process.env.APPDATA || "", "gh", "hosts.yml"), // Windows
  ];

  for (const hostsPath of configPaths) {
    if (!existsSync(hostsPath)) continue;

    try {
      const content = readFileSync(hostsPath, "utf-8");
      const match = content.match(/oauth_token:\s*(\S+)/);
      if (match) return match[1];
    } catch {
      continue;
    }
  }

  return null;
}
