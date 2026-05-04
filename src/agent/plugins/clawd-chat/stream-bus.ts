/**
 * StreamBus — transport seam for chat-plugin streaming side effects.
 *
 * The chat plugin emits 3 kinds of streaming events: setStreaming (with a DB
 * write side effect), streamToken (pure broadcast), streamToolCall (pure
 * broadcast). Historically these went out over an HTTP loopback to the same
 * Bun process. When agent and server share a process (the common case —
 * `directDb` path in WorkerLoop), the loopback is pure overhead: TCP
 * connect/handshake, JSON serialise, JSON parse, dispatch — back into the
 * same process.
 *
 * StreamBus has two impls:
 *   - HttpStreamBus: original timedFetch behaviour. Used by remote workers
 *     (workerToken set, directDb=false) where the server is in another
 *     process.
 *   - InProcessStreamBus: direct function calls into the server's
 *     setAgentStreaming + broadcast helpers. Best-effort: errors swallowed
 *     so a broadcast throw cannot kill the agent loop.
 *
 * Selection happens in worker-loop.ts based on the existing `directDb` flag;
 * no new flag is invented.
 */

import { timedFetch as defaultTimedFetch } from "../../../utils/timed-fetch";

export type TokenType = "content" | "thinking" | "event";
export type ToolCallStatus = "started" | "completed" | "error";

export interface StreamBus {
  setStreaming(agentId: string, channel: string, isStreaming: boolean): Promise<void>;
  streamToken(agentId: string, channel: string, token: string, tokenType: TokenType): Promise<void>;
  streamToolCall(
    agentId: string,
    channel: string,
    toolName: string,
    toolArgs: any,
    status: ToolCallStatus,
    result?: any,
    toolUseId?: string,
  ): Promise<void>;
}

type TimedFetch = (url: string, options?: RequestInit, ms?: number) => Promise<Response>;

/**
 * HttpStreamBus — the legacy path. Bytes-on-the-wire identical to the inline
 * timedFetch calls it replaces, so remote-worker behaviour is unchanged.
 */
export class HttpStreamBus implements StreamBus {
  private readonly apiUrl: string;
  private readonly fetch: TimedFetch;

  constructor(apiUrl: string, fetch: TimedFetch = defaultTimedFetch) {
    this.apiUrl = apiUrl.replace(/\/$/, "");
    this.fetch = fetch;
  }

  async setStreaming(agentId: string, channel: string, isStreaming: boolean): Promise<void> {
    try {
      await this.fetch(`${this.apiUrl}/api/agent.setStreaming`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          agent_id: agentId,
          channel,
          is_streaming: isStreaming,
        }),
      });
    } catch {
      // best-effort
    }
  }

  async streamToken(agentId: string, channel: string, token: string, tokenType: TokenType): Promise<void> {
    try {
      await this.fetch(`${this.apiUrl}/api/agent.streamToken`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          agent_id: agentId,
          channel,
          token,
          token_type: tokenType,
        }),
      });
    } catch {
      // best-effort
    }
  }

  async streamToolCall(
    agentId: string,
    channel: string,
    toolName: string,
    toolArgs: any,
    status: ToolCallStatus,
    result?: any,
    toolUseId?: string,
  ): Promise<void> {
    try {
      await this.fetch(`${this.apiUrl}/api/agent.streamToolCall`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          agent_id: agentId,
          channel,
          tool_name: toolName,
          tool_args: toolArgs,
          tool_use_id: toolUseId,
          status,
          result,
        }),
      });
    } catch {
      // best-effort
    }
  }
}

/**
 * InProcessStreamBus — direct fn calls when agent + server share a process.
 *
 * Dependencies are injected (not direct-imported) so the bus is unit-testable
 * without booting the server module graph. The server's status route does
 * setAgentStreaming → if (success) broadcastAgentStreaming; this bus
 * replicates that pattern exactly.
 */
export interface InProcessStreamBusDeps {
  setAgentStreaming(agentId: string, channel: string, isStreaming: boolean): boolean;
  broadcastAgentStreaming(channel: string, agentId: string, isStreaming: boolean): void;
  broadcastAgentToken(channel: string, agentId: string, token: string, tokenType: string): void;
  broadcastAgentToolCall(
    channel: string,
    agentId: string,
    toolName: string,
    toolArgs: any,
    status: string,
    result?: any,
    toolUseId?: string,
  ): void;
}

/**
 * Selects the in-process bus when agent + server share a process, otherwise
 * returns undefined so the chat plugin falls back to HttpStreamBus. The
 * `directDb !== false` shape mirrors the same gate used elsewhere in
 * worker-loop.ts so the local/remote seam stays in one place.
 */
export function buildStreamBus(directDb: boolean | undefined, deps: InProcessStreamBusDeps): StreamBus | undefined {
  return directDb !== false ? new InProcessStreamBus(deps) : undefined;
}

export class InProcessStreamBus implements StreamBus {
  constructor(private readonly deps: InProcessStreamBusDeps) {}

  async setStreaming(agentId: string, channel: string, isStreaming: boolean): Promise<void> {
    try {
      const ok = this.deps.setAgentStreaming(agentId, channel, isStreaming);
      if (ok) this.deps.broadcastAgentStreaming(channel, agentId, isStreaming);
    } catch (err) {
      // best-effort, but DB-write failures (e.g. SQLite WAL lock) are
      // operationally relevant — log so they don't disappear silently the way
      // they would have surfaced as a non-2xx on the old HTTP loopback path.
      console.warn("[InProcessStreamBus] setStreaming failed:", err);
    }
  }

  async streamToken(agentId: string, channel: string, token: string, tokenType: TokenType): Promise<void> {
    try {
      this.deps.broadcastAgentToken(channel, agentId, token, tokenType);
    } catch {
      // best-effort
    }
  }

  async streamToolCall(
    agentId: string,
    channel: string,
    toolName: string,
    toolArgs: any,
    status: ToolCallStatus,
    result?: any,
    toolUseId?: string,
  ): Promise<void> {
    try {
      this.deps.broadcastAgentToolCall(channel, agentId, toolName, toolArgs, status, result, toolUseId);
    } catch {
      // best-effort
    }
  }
}
