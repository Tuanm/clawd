/**
 * Copilot API Client with HTTP/2 and Streaming Support
 */
import http2 from "node:http2";
import { EventEmitter } from "node:events";
const COPILOT_API_URL = "https://api.githubcopilot.com";
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
import { isDebugEnabled } from "../utils/debug";
// Local override for API-specific debug (can be set independently)
let localDebugEnabled = null;
function isApiDebugEnabled() {
  // If local override is set, use it; otherwise use global debug state
  return localDebugEnabled ?? isDebugEnabled();
}
function logRequest(request) {
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
function logResponse(status, body) {
  if (!isApiDebugEnabled()) return;
  if (status === 200) {
    console.log(`\x1b[32m[API Response]\x1b[0m ${status} OK`);
  } else {
    console.log(`\x1b[31m[API Response]\x1b[0m ${status} ${body?.slice(0, 500)}`);
  }
}
function logStreamEvent(event) {
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
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
export class CopilotClient extends EventEmitter {
  token;
  client = null;
  model;
  baseUrl;
  apiPath = "/chat/completions";
  // Enable debug logging: CopilotClient.debug = true or use --debug flag
  static set debug(value) {
    localDebugEnabled = value;
  }
  static get debug() {
    return isApiDebugEnabled();
  }
  constructor(token, options) {
    super();
    this.token = token;
    this.model = options?.model || "claude-opus-4.6";
    this.baseUrl = options?.baseUrl || COPILOT_API_URL;
  }
  getClient() {
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
      this.client = http2.connect(this.baseUrl);
      this.client.on("connect", () => {
        clearTimeout(timer);
        resolve(this.client);
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
  async complete(request) {
    let lastError = null;
    for (let attempt = 0; attempt <= RATE_LIMIT_MAX_RETRIES; attempt++) {
      try {
        return await this._completeOnce(request);
      } catch (error) {
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
  async _completeOnce(request) {
    const client = await this.getClient();
    logRequest(request);
    return new Promise((resolve, reject) => {
      const headers = {
        ":method": "POST",
        ":path": this.apiPath,
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
        const status = headers[":status"];
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
  async *stream(request, signal) {
    let lastError = null;
    for (let attempt = 0; attempt <= RATE_LIMIT_MAX_RETRIES; attempt++) {
      try {
        // Try to stream, yield all events
        for await (const event of this._streamOnce(request, signal)) {
          yield event;
        }
        return; // Success, exit retry loop
      } catch (error) {
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
  async *_streamOnce(request, signal) {
    const client = await this.getClient();
    logRequest(request);
    const headers = {
      ":method": "POST",
      ":path": this.apiPath,
      Authorization: `Bearer ${this.token}`,
      "X-Interaction-Id": crypto.randomUUID(),
      ...BASE_HEADERS,
    };
    const body = JSON.stringify({ ...request, stream: true });
    const req = client.request(headers);
    // Create a queue for streaming events
    const queue = [];
    let done = false;
    let error = null;
    let resolver = null;
    let aborted = false;
    // Idle timeout: if no data received for STREAM_IDLE_TIMEOUT_MS, abort
    let idleTimer = null;
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
    const push = (event) => {
      if (aborted) return;
      logStreamEvent(event);
      queue.push(event);
      resolver?.();
    };
    let buffer = "";
    const currentToolCalls = new Map();
    let errorBody = "";
    req.on("response", (headers) => {
      const status = headers[":status"];
      logResponse(status, status !== 200 ? errorBody : undefined);
      if (status !== 200) {
        // Collect error body before rejecting
        req.on("data", (chunk) => {
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
    req.on("data", (chunk) => {
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
          const json = JSON.parse(data);
          const choice = json.choices[0];
          if (!choice) continue;
          // Handle content delta
          if (choice.delta?.content) {
            push({ type: "content", content: choice.delta.content });
          }
          // Handle thinking/reasoning delta (Claude extended thinking)
          // Check for thinking content in various possible locations
          const thinking = choice.delta?.thinking || choice.delta?.reasoning || choice.delta?.internal_monologue;
          if (thinking) {
            push({ type: "thinking", content: thinking });
          }
          // Handle tool calls delta
          if (choice.delta?.tool_calls) {
            for (const tc of choice.delta.tool_calls) {
              const idx = tc.index ?? 0;
              let existing = currentToolCalls.get(idx);
              if (!existing) {
                // Use provided id if available (Copilot/OpenAI), otherwise use index (Ollama)
                // This handles both cases: Copilot sends id, Ollama doesn't
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
        yield queue.shift();
        continue;
      }
      if (done || error) break;
      // Wait for next event
      await new Promise((resolve) => {
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
