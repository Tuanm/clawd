#!/usr/bin/env bun
/**
 * Claw'd - Copilot API Proxy Server
 *
 * A proxy server that forwards requests to GitHub Copilot API.
 * Supports streaming (SSE) and all Copilot models.
 *
 * Usage:
 *   clawd              # Start server on port 3456
 *   clawd --port 8080  # Start server on custom port
 */

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { API_CONFIG } from "./api/config";

// ============================================================================
// Configuration
// ============================================================================

const CONFIG = {
  DEFAULT_PORT: 3456,
  HEADERS: {
    "Content-Type": "application/json",
    Accept: "application/json",
    "X-Interaction-Type": "conversation-agent",
    "Openai-Intent": "conversation-agent",
    "X-Initiator": "agent",
    "X-GitHub-Api-Version": "2025-05-01",
    "Copilot-Integration-Id": "copilot-developer-cli",
    "User-Agent": "Claw'd/1.0.0",
  },
};

// ============================================================================
// Authentication
// ============================================================================

function getGHToken(): string | null {
  if (process.env.COPILOT_GITHUB_TOKEN) return process.env.COPILOT_GITHUB_TOKEN;
  if (process.env.GH_TOKEN) return process.env.GH_TOKEN;
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN;

  const configPaths = [
    join(homedir(), ".config", "gh", "hosts.yml"),
    join(homedir(), "Library", "Application Support", "gh", "hosts.yml"),
    join(process.env.APPDATA || "", "gh", "hosts.yml"),
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

// ============================================================================
// Anthropic <-> OpenAI Format Conversion
// ============================================================================

interface AnthropicMessage {
  role: "user" | "assistant";
  content: string | Array<{ type: string; text?: string; [key: string]: any }>;
}

interface AnthropicRequest {
  model: string;
  messages: AnthropicMessage[];
  system?: string | Array<{ type: string; text: string }>;
  max_tokens: number;
  stream?: boolean;
  temperature?: number;
  top_p?: number;
  stop_sequences?: string[];
  metadata?: { user_id?: string };
}

interface OpenAIMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

interface OpenAIRequest {
  model: string;
  messages: OpenAIMessage[];
  stream?: boolean;
  temperature?: number;
  top_p?: number;
  max_completion_tokens?: number;
  stop?: string[];
}

function anthropicToOpenAI(req: AnthropicRequest): OpenAIRequest {
  const messages: OpenAIMessage[] = [];

  // Handle system prompt
  if (req.system) {
    const systemContent = typeof req.system === "string" ? req.system : req.system.map((b) => b.text).join("\n");
    messages.push({ role: "system", content: systemContent });
  }

  // Convert messages
  for (const msg of req.messages) {
    const content =
      typeof msg.content === "string"
        ? msg.content
        : msg.content
            .filter((b) => b.type === "text")
            .map((b) => b.text)
            .join("\n");
    messages.push({ role: msg.role, content });
  }

  return {
    model: req.model,
    messages,
    stream: req.stream,
    temperature: req.temperature,
    top_p: req.top_p,
    max_completion_tokens: req.max_tokens,
    stop: req.stop_sequences,
  };
}

function openAIToAnthropicResponse(openaiResponse: any, model: string): any {
  const choice = openaiResponse.choices?.[0];
  const message = choice?.message;

  return {
    id: openaiResponse.id || `msg_${crypto.randomUUID().replace(/-/g, "")}`,
    type: "message",
    role: "assistant",
    content: [
      {
        type: "text",
        text: message?.content || "",
      },
    ],
    model,
    stop_reason: choice?.finish_reason === "stop" ? "end_turn" : choice?.finish_reason || null,
    stop_sequence: null,
    usage: {
      input_tokens: openaiResponse.usage?.prompt_tokens || 0,
      output_tokens: openaiResponse.usage?.completion_tokens || 0,
    },
  };
}

function createAnthropicStreamTransformer(model: string, messageId: string) {
  let contentIndex = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let sentStart = false;

  return new TransformStream({
    transform(chunk, controller) {
      const text = new TextDecoder().decode(chunk);
      const lines = text.split("\n");

      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;
        const data = line.slice(6).trim();
        if (data === "[DONE]") {
          // Send message_delta with stop_reason and message_stop
          controller.enqueue(
            new TextEncoder().encode(
              `event: message_delta\ndata: ${JSON.stringify({
                type: "message_delta",
                delta: { stop_reason: "end_turn", stop_sequence: null },
                usage: { output_tokens: outputTokens },
              })}\n\n`,
            ),
          );
          controller.enqueue(new TextEncoder().encode(`event: message_stop\ndata: {"type":"message_stop"}\n\n`));
          continue;
        }

        try {
          const parsed = JSON.parse(data);

          // Send message_start on first chunk
          if (!sentStart) {
            sentStart = true;
            inputTokens = parsed.usage?.prompt_tokens || 0;
            controller.enqueue(
              new TextEncoder().encode(
                `event: message_start\ndata: ${JSON.stringify({
                  type: "message_start",
                  message: {
                    id: messageId,
                    type: "message",
                    role: "assistant",
                    content: [],
                    model,
                    stop_reason: null,
                    stop_sequence: null,
                    usage: { input_tokens: inputTokens, output_tokens: 0 },
                  },
                })}\n\n`,
              ),
            );
            controller.enqueue(
              new TextEncoder().encode(
                `event: content_block_start\ndata: ${JSON.stringify({
                  type: "content_block_start",
                  index: 0,
                  content_block: { type: "text", text: "" },
                })}\n\n`,
              ),
            );
          }

          // Extract delta content
          const delta = parsed.choices?.[0]?.delta;
          if (delta?.content) {
            outputTokens += 1; // Approximate token count
            controller.enqueue(
              new TextEncoder().encode(
                `event: content_block_delta\ndata: ${JSON.stringify({
                  type: "content_block_delta",
                  index: 0,
                  delta: { type: "text_delta", text: delta.content },
                })}\n\n`,
              ),
            );
          }

          // Check for finish
          if (parsed.choices?.[0]?.finish_reason) {
            controller.enqueue(
              new TextEncoder().encode(
                `event: content_block_stop\ndata: ${JSON.stringify({
                  type: "content_block_stop",
                  index: 0,
                })}\n\n`,
              ),
            );
          }
        } catch {
          // Skip invalid JSON
        }
      }
    },
  });
}

// ============================================================================
// Proxy Handler
// ============================================================================

async function handleRequest(req: Request, token: string): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname;

  // Health check endpoint
  if (path === "/health" || path === "/") {
    return new Response(JSON.stringify({ status: "ok", service: "clawd-proxy" }), {
      headers: { "Content-Type": "application/json" },
    });
  }

  // Models endpoint - OpenAI format
  if (path === "/v1/models" || path === "/models") {
    return new Response(
      JSON.stringify({
        object: "list",
        data: [
          { id: "claude-sonnet-4.5", object: "model", owned_by: "anthropic" },
          { id: "claude-opus-4.5", object: "model", owned_by: "anthropic" },
          { id: "gpt-4.1", object: "model", owned_by: "openai" },
          { id: "gpt-4o", object: "model", owned_by: "openai" },
          { id: "o3-mini", object: "model", owned_by: "openai" },
          { id: "gemini-2.0-flash-001", object: "model", owned_by: "google" },
        ],
      }),
      { headers: { "Content-Type": "application/json" } },
    );
  }

  // Anthropic Messages API endpoint
  if (path === "/v1/messages" || path === "/messages") {
    if (req.method !== "POST") {
      return new Response(
        JSON.stringify({
          type: "error",
          error: {
            type: "invalid_request_error",
            message: "Method not allowed",
          },
        }),
        { status: 405, headers: { "Content-Type": "application/json" } },
      );
    }

    try {
      const body = await req.text();
      const anthropicReq: AnthropicRequest = JSON.parse(body);
      const isStreaming = anthropicReq.stream === true;
      const model = anthropicReq.model;
      const messageId = `msg_${crypto.randomUUID().replace(/-/g, "")}`;

      // Convert to OpenAI format
      const openaiReq = anthropicToOpenAI(anthropicReq);

      const upstreamResponse = await fetch(`${CONFIG.API_URL}/chat/completions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "X-Interaction-Id": crypto.randomUUID(),
          ...CONFIG.HEADERS,
        },
        body: JSON.stringify(openaiReq),
      });

      if (!upstreamResponse.ok) {
        const errorText = await upstreamResponse.text();
        return new Response(
          JSON.stringify({
            type: "error",
            error: { type: "api_error", message: errorText },
          }),
          {
            status: upstreamResponse.status,
            headers: { "Content-Type": "application/json" },
          },
        );
      }

      if (isStreaming) {
        // Transform OpenAI SSE stream to Anthropic SSE stream
        const transformer = createAnthropicStreamTransformer(model, messageId);
        const transformedStream = upstreamResponse.body!.pipeThrough(transformer);

        return new Response(transformedStream, {
          headers: {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            Connection: "keep-alive",
            "Access-Control-Allow-Origin": "*",
          },
        });
      } else {
        // Convert OpenAI response to Anthropic format
        const openaiResponse = await upstreamResponse.json();
        const anthropicResponse = openAIToAnthropicResponse(openaiResponse, model);

        return new Response(JSON.stringify(anthropicResponse), {
          headers: {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*",
          },
        });
      }
    } catch (error: any) {
      return new Response(
        JSON.stringify({
          type: "error",
          error: { type: "api_error", message: error.message },
        }),
        { status: 500, headers: { "Content-Type": "application/json" } },
      );
    }
  }

  // Chat completions - proxy to Copilot API (OpenAI format)
  if (path === "/v1/chat/completions" || path === "/chat/completions") {
    if (req.method !== "POST") {
      return new Response(JSON.stringify({ error: "Method not allowed" }), {
        status: 405,
        headers: { "Content-Type": "application/json" },
      });
    }

    try {
      const body = await req.text();
      const requestBody = JSON.parse(body);
      const isStreaming = requestBody.stream === true;

      const upstreamResponse = await fetch(`${CONFIG.API_URL}/v1/chat/completions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "X-Interaction-Id": crypto.randomUUID(),
          ...CONFIG.HEADERS,
        },
        body,
      });

      if (!upstreamResponse.ok) {
        const errorText = await upstreamResponse.text();
        return new Response(errorText, {
          status: upstreamResponse.status,
          headers: { "Content-Type": "application/json" },
        });
      }

      if (isStreaming) {
        // Stream the response as SSE
        return new Response(upstreamResponse.body, {
          headers: {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            Connection: "keep-alive",
            "Access-Control-Allow-Origin": "*",
          },
        });
      } else {
        // Non-streaming response
        const responseBody = await upstreamResponse.text();
        return new Response(responseBody, {
          headers: {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*",
          },
        });
      }
    } catch (error: any) {
      return new Response(JSON.stringify({ error: error.message }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      });
    }
  }

  // CORS preflight
  if (req.method === "OPTIONS") {
    return new Response(null, {
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization, x-api-key, anthropic-version",
      },
    });
  }

  return new Response(JSON.stringify({ error: "Not found" }), {
    status: 404,
    headers: { "Content-Type": "application/json" },
  });
}

// ============================================================================
// Main
// ============================================================================

async function main() {
  const args = process.argv.slice(2);

  // Help
  if (args.includes("-h") || args.includes("--help")) {
    console.log("Claw'd - Copilot API Proxy Server\n");
    console.log("Usage: clawd [--port PORT]\n");
    console.log("Options:");
    console.log("  --port, -p <port>  Port to listen on (default: 3456)");
    console.log("  --help, -h         Show this help message");
    console.log("\nEndpoints:");
    console.log("  GET  /health              Health check");
    console.log("  GET  /v1/models           List available models");
    console.log("  POST /v1/chat/completions Chat completions (OpenAI format)");
    console.log("  POST /v1/messages         Messages API (Anthropic format)");
    console.log("\nExamples:");
    console.log("  # OpenAI format");
    console.log(
      '  curl http://localhost:3456/v1/chat/completions -d \'{"model":"claude-sonnet-4","messages":[{"role":"user","content":"Hello"}]}\'',
    );
    console.log("\n  # Anthropic format");
    console.log(
      '  curl http://localhost:3456/v1/messages -d \'{"model":"claude-sonnet-4","max_tokens":1024,"messages":[{"role":"user","content":"Hello"}]}\'',
    );
    process.exit(0);
  }

  // Parse port
  let port = CONFIG.DEFAULT_PORT;
  const portIndex = args.findIndex((a) => a === "--port" || a === "-p");
  if (portIndex !== -1 && args[portIndex + 1]) {
    port = parseInt(args[portIndex + 1], 10);
    if (isNaN(port)) {
      console.error("Error: Invalid port number");
      process.exit(1);
    }
  }

  // Get token
  const token = getGHToken();
  if (!token) {
    console.error("Error: No GitHub token found.");
    console.error("Run `gh auth login` then `gh auth refresh -s copilot`");
    process.exit(1);
  }

  // Start server
  console.log(`Claw'd - Copilot API Proxy`);
  console.log(`Listening on http://localhost:${port}`);
  console.log(`\nEndpoints:`);
  console.log(`  GET  /health              - Health check`);
  console.log(`  GET  /v1/models           - List models`);
  console.log(`  POST /v1/chat/completions - Chat completions (OpenAI format)`);
  console.log(`  POST /v1/messages         - Messages API (Anthropic format)`);
  console.log(`\nPress Ctrl+C to stop\n`);

  Bun.serve({
    port,
    fetch: (req) => handleRequest(req, token),
  });
}

main();
