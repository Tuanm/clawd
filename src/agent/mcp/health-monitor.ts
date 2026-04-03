/**
 * MCPHealthMonitor — reconnects dead MCP servers with exponential backoff.
 *
 * Stores connection refs internally so HTTP error events (which have no
 * connection reference at the call site) can still trigger reconnects.
 */

import type { IMCPConnection } from "./client";

export class MCPHealthMonitor {
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  private attempts = new Map<string, number>();
  private connections = new Map<string, IMCPConnection>();
  private onDeadCbs = new Map<string, (name: string) => void>();
  /** Names currently mid-connect() — guards against duplicate reconnect triggers. */
  private reconnecting = new Set<string>();
  /** Stored handler refs so we can call conn.off() on stop() to prevent ghost listeners. */
  private disconnectHandlers = new Map<string, () => void>();

  /**
   * Start watching a connection.
   * Must be called BEFORE connection.connect() so the "disconnected" event
   * fired during the initial attempt is captured.
   */
  watch(name: string, connection: IMCPConnection, onDead: (name: string) => void): void {
    this.connections.set(name, connection);
    this.onDeadCbs.set(name, onDead);
    const handler = () => {
      this.scheduleReconnect(name, 1_000);
    };
    this.disconnectHandlers.set(name, handler);
    connection.on("disconnected", handler);
  }

  /**
   * Bridge for HTTP error events — the connection emits "error" on network
   * failures, but the caller has no ref at that point.  Only schedules if no
   * reconnect is already in-flight for this name.
   */
  handleError(name: string, _err: Error): void {
    if (!this.timers.has(name) && !this.reconnecting.has(name)) {
      this.scheduleReconnect(name, 1_000);
    }
  }

  /** Returns the current reconnect attempt count (0 = healthy). */
  getAttempts(name: string): number {
    return this.attempts.get(name) ?? 0;
  }

  /** Stop watching a single server (call before intentional disconnect). */
  stop(name: string): void {
    clearTimeout(this.timers.get(name));
    this.timers.delete(name);
    this.reconnecting.delete(name);
    this.attempts.delete(name);
    this.onDeadCbs.delete(name);
    const conn = this.connections.get(name);
    const handler = this.disconnectHandlers.get(name);
    if (conn && handler) conn.off("disconnected", handler);
    this.disconnectHandlers.delete(name);
    this.connections.delete(name);
  }

  /** Stop all watches and clear all state (call on manager shutdown). */
  stopAll(): void {
    for (const name of [...this.connections.keys()]) this.stop(name);
  }

  private scheduleReconnect(name: string, delayMs: number): void {
    // Clear any pending timer — prevents stale timers accumulating on rapid retries
    clearTimeout(this.timers.get(name));
    this.timers.delete(name);

    // Guard: connect() is already awaiting for this name — don't stack another attempt
    if (this.reconnecting.has(name)) return;

    const conn = this.connections.get(name);
    // Guard: already stopped (intentional disconnect or stopAll)
    if (!conn) return;

    const onDead = this.onDeadCbs.get(name);
    const attempts = (this.attempts.get(name) ?? 0) + 1;

    if (attempts > 10) {
      this.timers.delete(name);
      this.reconnecting.delete(name);
      this.attempts.delete(name);
      this.connections.delete(name);
      this.onDeadCbs.delete(name);
      onDead?.(name);
      return;
    }

    this.attempts.set(name, attempts);

    const jitter = Math.random() * delayMs * 0.2;
    const timer = setTimeout(async () => {
      this.timers.delete(name);
      // Re-check: may have been stopped while timer was pending
      if (!this.connections.has(name)) return;
      this.reconnecting.add(name);
      try {
        await conn.connect();
        this.attempts.delete(name);
        this.reconnecting.delete(name);
        console.log(`[MCP] Reconnected: ${name} (attempt ${attempts})`);
      } catch {
        this.reconnecting.delete(name);
        this.scheduleReconnect(name, Math.min(delayMs * 2, 30_000));
      }
    }, delayMs + jitter);

    this.timers.set(name, timer);
  }
}
