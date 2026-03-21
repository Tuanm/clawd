/**
 * Copilot API Client with HTTP/2 and Streaming Support
 */

import { EventEmitter } from "node:events";
import http2 from "node:http2";
import { trackFailure, trackSuccess } from "../../analytics";
import { callContext } from "./call-context";
import { AllKeysSuspendedError, keyPool } from "./key-pool";
import { ensureKeyPoolInitialized, getBaseUrlForProvider, getCopilotToken } from "./provider-config";

const COPILOT_API_URL = "https://api.githubcopilot.com";

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
  // "X-Initiator" is NOT set here — it's set dynamically per-request based on initiator
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
// Errors
// ============================================================================

export class ApiResponseError extends Error {
  constructor(
    public readonly status: number,
    public readonly token: string,
    public readonly retryAfterMs: number | undefined,
    body: string,
  ) {
    super(`API error ${status} [key=${truncateKey(token)}]: ${body}`);
    this.name = "ApiResponseError";
  }
}

// ============================================================================
// Client
// ============================================================================

// Timeout constants
const CONNECT_TIMEOUT_MS = 10_000; // 10s to establish HTTP/2 connection
const REQUEST_TIMEOUT_MS = 120_000; // 120s for non-streaming requests (LLM can be slow)
// State-based stream timeouts (behavior-driven, not model-name-driven):
const STREAM_TIMEOUT_CONNECTING_MS = 30_000; // 30s — waiting for HTTP response headers (connection issue)
const STREAM_TIMEOUT_PROCESSING_MS = 300_000; // 300s — headers received but no data yet (model thinking)
const STREAM_TIMEOUT_STREAMING_MS = 180_000; // 180s — pause between data chunks (mid-response thinking)

/** Show first 4 + last 4 characters of an API key for debugging failed requests. */
function truncateKey(key: string): string {
  if (!key || key.length <= 8) return "****";
  return `${key.slice(0, 4)}...${key.slice(-4)}`;
}

export class CopilotClient extends EventEmitter {
  private token: string;
  // NOTE: H2 sessions are now owned by KeyPool (shared per-token across all agents).
  // This instance keeps a reference only as an emergency fallback for non-KeyPool paths.
  private localSession: http2.ClientHttp2Session | null = null;
  readonly model: string;
  private baseUrl: string;
  private apiPath: string = "/chat/completions";

  // Enable debug logging: CopilotClient.debug = true or use --debug flag
  static set debug(value: boolean) {
    localDebugEnabled = value;
  }
  static get debug(): boolean {
    return isApiDebugEnabled();
  }

  constructor(token: string, options?: { model?: string; baseUrl?: string }) {
    super();
    this.token = token;
    this.model = options?.model || "claude-opus-4.6";
    this.baseUrl = options?.baseUrl || COPILOT_API_URL;
  }

  /** Get a working H2 session: prefer KeyPool-shared session, fallback to local. */
  private async getClient(token: string): Promise<http2.ClientHttp2Session> {
    // Try KeyPool-shared session first
    try {
      return await keyPool.getOrCreateSession(token, this.baseUrl);
    } catch {
      // Fallback: create a local session (for when KeyPool is not initialized)
      return this.getLocalSession();
    }
  }

  private getLocalSession(): Promise<http2.ClientHttp2Session> {
    return new Promise((resolve, reject) => {
      if (this.localSession && !this.localSession.destroyed) {
        resolve(this.localSession);
        return;
      }

      const timer = setTimeout(() => {
        reject(new Error(`HTTP/2 connection timeout after ${CONNECT_TIMEOUT_MS}ms`));
        this.localSession?.destroy();
        this.localSession = null;
      }, CONNECT_TIMEOUT_MS);

      this.localSession = http2.connect(this.baseUrl);
      this.localSession.on("connect", () => {
        clearTimeout(timer);
        resolve(this.localSession!);
      });
      this.localSession.on("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });
      this.localSession.on("close", () => {
        this.localSession = null;
      });
    });
  }

  /**
   * Fetch token limit for a model from the Copilot /models endpoint.
   * Returns limits.max_context_window_tokens if available.
   */
  async fetchModelTokenLimit(model: string): Promise<number | null> {
    try {
      const token = getCopilotToken() || this.token;
      const res = await fetch(`${this.baseUrl}/models`, {
        headers: { Authorization: `Bearer ${token}`, ...BASE_HEADERS },
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) return null;
      const data = (await res.json()) as {
        data?: Array<{ id: string; limits?: { max_context_window_tokens?: number } }>;
      };
      const found = data.data?.find((m) => m.id === model);
      return found?.limits?.max_context_window_tokens ?? null;
    } catch {
      return null;
    }
  }

  /**
   * Send a completion request with key rotation on 429/403.
   * @param initiator "user" = counts as premium request; "agent" = 0 premium cost (default)
   */
  async complete(request: CompletionRequest, initiator: "agent" | "user" = "agent"): Promise<CompletionResponse> {
    // Trigger lazy KeyPool initialization (no inFlight side-effect — uses peekToken internally)
    ensureKeyPoolInitialized();

    let key = (() => {
      try {
        return keyPool.selectKey(initiator);
      } catch (err) {
        if (err instanceof AllKeysSuspendedError) throw err; // propagate — don't silently fall back
        return null; // pool not initialized — fall back to raw token
      }
    })();

    // If KeyPool unavailable (not initialized), fall back to simple single-token request
    if (!key) {
      return this._completeOnce(request, getCopilotToken() || this.token, initiator);
    }

    // Resolve effective initiator: occasionally promote "agent" → "user" per-key daily budget
    const effectiveInitiator = keyPool.resolveInitiator(key, initiator);

    const maxSwitches = Math.max(keyPool.keyCount, 1);
    let lastError: Error | null = null;

    for (let switches = 0; switches <= maxSwitches; switches++) {
      const t0 = Date.now();
      const ctx = callContext.getStore();
      try {
        await keyPool.waitForSpacing(key);
        const result = await this._completeOnce(request, key.token, effectiveInitiator);
        keyPool.recordRequest(key.token, request.model, effectiveInitiator);
        trackSuccess({
          keyFingerprint: key.fingerprint,
          model: request.model,
          initiator: effectiveInitiator,
          latencyMs: Date.now() - t0,
          promptTokens: result.usage?.prompt_tokens,
          completionTokens: result.usage?.completion_tokens,
          agentId: ctx?.agentId,
          channel: ctx?.channel,
        });
        return result;
      } catch (err) {
        if (err instanceof ApiResponseError && (err.status === 429 || err.status === 403)) {
          keyPool.reportError(key.token, err.status, err.retryAfterMs, err.message);
          trackFailure({
            keyFingerprint: key.fingerprint,
            model: request.model,
            initiator: effectiveInitiator,
            status: String(err.status) as "429" | "403",
            latencyMs: Date.now() - t0,
            errorMsg: err.message,
            agentId: ctx?.agentId,
            channel: ctx?.channel,
          });
          if (err.status === 403) {
            keyPool.destroySession(key.token);
          }
          lastError = err;
          try {
            key = keyPool.selectKey(effectiveInitiator);
          } catch (e2) {
            throw e2; // AllKeysSuspendedError
          }
          continue;
        }
        // Non-rate-limit error — release the inFlight slot before re-throwing
        keyPool.releaseKey(key.token);
        trackFailure({
          keyFingerprint: key.fingerprint,
          model: request.model,
          initiator: effectiveInitiator,
          status: "error",
          latencyMs: Date.now() - t0,
          errorMsg: err instanceof Error ? err.message : String(err),
          agentId: ctx?.agentId,
          channel: ctx?.channel,
        });
        throw err;
      }
    }

    throw lastError || new Error("All Copilot key rotation attempts exhausted");
  }

  private async _completeOnce(
    request: CompletionRequest,
    activeToken: string,
    initiator: "agent" | "user",
  ): Promise<CompletionResponse> {
    const client = await this.getClient(activeToken);
    logRequest(request);

    return new Promise((resolve, reject) => {
      const headers = {
        ":method": "POST",
        ":path": this.apiPath,
        Authorization: `Bearer ${activeToken}`,
        "X-Interaction-Id": crypto.randomUUID(),
        "X-Initiator": initiator,
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

      req.on("response", (respHeaders) => {
        const status = respHeaders[":status"] as number;
        if (status !== 200) {
          const retryAfterRaw = respHeaders["retry-after"];
          const retryAfterMs = retryAfterRaw ? parseInt(String(retryAfterRaw), 10) * 1000 : undefined;
          req.on("data", (chunk) => (data += chunk));
          req.on("end", () => {
            clearTimeout(timer);
            logResponse(status, data);
            reject(new ApiResponseError(status, activeToken, retryAfterMs, data));
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

  /**
   * Stream a completion request with key rotation on 429/403.
   * @param initiator "user" = counts as premium request; "agent" = 0 premium cost (default)
   */
  async *stream(
    request: CompletionRequest,
    signal?: AbortSignal,
    initiator: "agent" | "user" = "agent",
  ): AsyncGenerator<StreamEvent> {
    // Trigger lazy KeyPool initialization (no inFlight side-effect)
    ensureKeyPoolInitialized();

    let key = (() => {
      try {
        return keyPool.selectKey(initiator);
      } catch (err) {
        if (err instanceof AllKeysSuspendedError) throw err; // propagate — don't silently fall back
        return null; // pool not initialized — fall back to raw token
      }
    })();

    if (!key) {
      // Fallback: single-token stream without KeyPool
      yield* this._streamOnce(request, getCopilotToken() || this.token, initiator, signal);
      return;
    }

    // Resolve effective initiator: occasionally promote "agent" → "user" per-key daily budget
    const effectiveInitiator = keyPool.resolveInitiator(key, initiator);

    const maxSwitches = Math.max(keyPool.keyCount, 1);

    for (let switches = 0; switches <= maxSwitches; switches++) {
      let streamError: ApiResponseError | null = null;
      const t0 = Date.now();
      const ctx = callContext.getStore();
      try {
        await keyPool.waitForSpacing(key);
        // Guard against early consumer exit (break/return) — must release inFlight slot
        let accounted = false;
        let lastEvent: StreamEvent | null = null;
        try {
          for await (const event of this._streamOnce(request, key.token, effectiveInitiator, signal)) {
            lastEvent = event;
            yield event;
          }
          keyPool.recordRequest(key.token, request.model, effectiveInitiator);
          accounted = true;
          trackSuccess({
            keyFingerprint: key.fingerprint,
            model: request.model,
            initiator: effectiveInitiator,
            latencyMs: Date.now() - t0,
            promptTokens: (lastEvent as { usage?: { prompt_tokens?: number } })?.usage?.prompt_tokens,
            completionTokens: (lastEvent as { usage?: { completion_tokens?: number } })?.usage?.completion_tokens,
            agentId: ctx?.agentId,
            channel: ctx?.channel,
          });
          return;
        } finally {
          if (!accounted) keyPool.releaseKey(key.token);
        }
      } catch (err) {
        if (err instanceof ApiResponseError && (err.status === 429 || err.status === 403)) {
          streamError = err;
        } else {
          // Non-rate-limit error — releaseKey already called by finally above
          trackFailure({
            keyFingerprint: key.fingerprint,
            model: request.model,
            initiator: effectiveInitiator,
            status: "error",
            latencyMs: Date.now() - t0,
            errorMsg: err instanceof Error ? err.message : String(err),
            agentId: ctx?.agentId,
            channel: ctx?.channel,
          });
          throw err;
        }
      }

      if (streamError) {
        keyPool.reportError(key.token, streamError.status as 403 | 429, streamError.retryAfterMs, streamError.message);
        trackFailure({
          keyFingerprint: key.fingerprint,
          model: request.model,
          initiator: effectiveInitiator,
          status: String(streamError.status) as "429" | "403",
          latencyMs: Date.now() - t0,
          errorMsg: streamError.message,
          agentId: ctx?.agentId,
          channel: ctx?.channel,
        });
        if (streamError.status === 403) {
          keyPool.destroySession(key.token);
        }
        try {
          key = keyPool.selectKey(effectiveInitiator);
        } catch (e2) {
          throw e2; // AllKeysSuspendedError
        }
      }
    }

    throw new Error("All Copilot key rotation attempts exhausted");
  }

  private async *_streamOnce(
    request: CompletionRequest,
    activeToken: string,
    initiator: "agent" | "user",
    signal?: AbortSignal,
  ): AsyncGenerator<StreamEvent> {
    const client = await this.getClient(activeToken);
    logRequest(request);

    const headers = {
      ":method": "POST",
      ":path": this.apiPath,
      Authorization: `Bearer ${activeToken}`,
      "X-Interaction-Id": crypto.randomUUID(),
      "X-Initiator": initiator,
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

    // State-based stream timeout: different timeouts for different phases
    // CONNECTING → got headers → PROCESSING → got first chunk → STREAMING
    let streamState: "connecting" | "processing" | "streaming" = "connecting";
    let idleTimer: ReturnType<typeof setTimeout> | null = null;

    const getTimeoutForState = (): number => {
      switch (streamState) {
        case "connecting":
          return STREAM_TIMEOUT_CONNECTING_MS; // 30s — connection issue
        case "processing":
          return STREAM_TIMEOUT_PROCESSING_MS; // 300s — model thinking
        case "streaming":
          return STREAM_TIMEOUT_STREAMING_MS; // 180s — pause between chunks
      }
    };

    const resetIdleTimer = () => {
      if (idleTimer) clearTimeout(idleTimer);
      const timeoutMs = getTimeoutForState();
      idleTimer = setTimeout(() => {
        if (!done && !aborted) {
          error = new Error(`Stream ${streamState} timeout after ${timeoutMs}ms`);
          req.close();
          resolver?.();
        }
      }, timeoutMs);
    };
    resetIdleTimer(); // Start in CONNECTING state (30s)

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
    let responseStatus = 200;
    let retryAfterMs: number | undefined;

    req.on("response", (respHeaders) => {
      responseStatus = respHeaders[":status"] as number;
      logResponse(responseStatus, responseStatus !== 200 ? errorBody : undefined);
      if (responseStatus !== 200) {
        // Non-200: clear idle timer (error path handles its own timing)
        if (idleTimer) clearTimeout(idleTimer);
        const retryAfterRaw = respHeaders["retry-after"];
        retryAfterMs = retryAfterRaw ? parseInt(String(retryAfterRaw), 10) * 1000 : undefined;
        req.on("data", (chunk: Buffer) => {
          errorBody += chunk.toString();
        });
        req.on("end", () => {
          logResponse(responseStatus, errorBody);
          error = new ApiResponseError(responseStatus, activeToken, retryAfterMs, errorBody);
          resolver?.();
        });
      } else {
        // 200 OK — transition to PROCESSING (waiting for first data chunk)
        streamState = "processing";
        resetIdleTimer(); // Reset with 300s timeout for model thinking
      }
    });

    req.on("data", (chunk: Buffer) => {
      if (aborted) return;
      // Transition to STREAMING on first data chunk
      if (streamState !== "streaming") {
        streamState = "streaming";
      }
      resetIdleTimer(); // Reset with 180s timeout for chunk gaps
      const normalized = chunk.toString().replace(/\r\n/g, "\n").replace(/\r/g, "\n"); // SSE spec
      const lines = (buffer + normalized).split("\n");
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
                const toolId = tc.id || String(idx);
                existing = {
                  id: toolId,
                  type: "function",
                  function: { name: "", arguments: "" },
                };
                currentToolCalls.set(idx, existing);
              }

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

      // Drain complete — check if stream ended
      if (done || error) break;

      // Wait for next event
      await new Promise<void>((resolve) => {
        resolver = resolve;
      });
      resolver = null;

      // After waking, drain any queued events before checking done/error
      // (prevents race where done is set while events are still queued)
      while (queue.length > 0) {
        yield queue.shift()!;
      }
    }

    if (error && !aborted) {
      // Re-throw ApiResponseError so retry loop can handle 429/403
      if (error instanceof ApiResponseError) throw error;
      yield { type: "error", error: error.message };
    }
  }

  close() {
    this.localSession?.close();
    this.localSession = null;
  }
}

// ============================================================================
// Token Helper
