/**
 * Context Budget Tracker — Phase 4.1
 * Tracks per-tool token consumption and provides context budget awareness.
 */

// ── Types ──────────────────────────────────────────────────────────

export interface ToolStats {
  calls: number;
  totalInputChars: number;
  totalOutputChars: number;
  totalCompressedChars: number;
  totalIndexed: number;
}

export interface ContextSnapshot {
  /** Percentage of context window used (0-100) */
  usagePercent: number;
  /** Estimated turns remaining at current consumption rate */
  turnsRemaining: number;
  /** Per-tool consumption breakdown */
  toolStats: Record<string, ToolStats>;
  /** Token composition */
  composition: {
    systemPrompt: number;
    messages: number;
    toolResults: number;
  };
  /** Total tokens estimated */
  totalTokens: number;
  /** Model context limit */
  modelLimit: number;
}

export interface CompressionEvent {
  toolName: string;
  originalSize: number;
  compressedSize: number;
  indexed: boolean;
}

// ── Tracker ────────────────────────────────────────────────────────

export class ContextTracker {
  private toolStats = new Map<string, ToolStats>();
  private recentTokensPerTurn: number[] = [];
  private searchQueries = new Map<string, number>(); // query → count for retry detection
  private modelLimit: number;
  private totalToolCalls = 0;

  constructor(modelLimit: number) {
    this.modelLimit = modelLimit;
  }

  /** Record a tool call with its input/output sizes */
  recordToolCall(
    toolName: string,
    inputChars: number,
    outputChars: number,
    compressedChars: number,
    indexed: boolean,
  ): void {
    const stats = this.toolStats.get(toolName) || {
      calls: 0,
      totalInputChars: 0,
      totalOutputChars: 0,
      totalCompressedChars: 0,
      totalIndexed: 0,
    };
    stats.calls++;
    stats.totalInputChars += inputChars;
    stats.totalOutputChars += outputChars;
    stats.totalCompressedChars += compressedChars;
    if (indexed) stats.totalIndexed++;
    this.toolStats.set(toolName, stats);
    this.totalToolCalls++;
  }

  /** Record a knowledge_search query for retry detection */
  recordSearch(query: string): void {
    const normalized = query.toLowerCase().trim();
    const count = (this.searchQueries.get(normalized) || 0) + 1;
    this.searchQueries.set(normalized, count);
  }

  /** Check for retry amplification (>3 searches for similar content) */
  getRetryWarning(): string | null {
    for (const [query, count] of this.searchQueries) {
      if (count > 3) {
        return `knowledge_search called ${count}x for "${query.slice(0, 40)}" — consider re-running the original tool`;
      }
    }
    return null;
  }

  /** Record tokens used this turn for estimating turns remaining */
  recordTurnTokens(tokens: number): void {
    this.recentTokensPerTurn.push(tokens);
    // Keep last 10 turns for averaging
    if (this.recentTokensPerTurn.length > 10) {
      this.recentTokensPerTurn.shift();
    }
  }

  /** Get context snapshot for budget injection */
  getSnapshot(currentTokens: number, systemPromptTokens: number): ContextSnapshot {
    const effectiveLimit = Math.floor(this.modelLimit * 0.8);
    const usagePercent = Math.round((currentTokens / effectiveLimit) * 100);

    // Estimate turns remaining
    let turnsRemaining = Infinity;
    if (this.recentTokensPerTurn.length > 0) {
      const avgPerTurn = this.recentTokensPerTurn.reduce((a, b) => a + b, 0) / this.recentTokensPerTurn.length;
      if (avgPerTurn > 0) {
        turnsRemaining = Math.floor((effectiveLimit - currentTokens) / avgPerTurn);
      }
    }

    // Calculate tool result tokens (approximate: ~3.5 chars per token)
    let toolResultTokens = 0;
    for (const stats of this.toolStats.values()) {
      toolResultTokens += Math.ceil(stats.totalCompressedChars / 3.5);
    }

    const stats: Record<string, ToolStats> = {};
    for (const [name, s] of this.toolStats) {
      stats[name] = { ...s };
    }

    return {
      usagePercent: Math.min(usagePercent, 100),
      turnsRemaining: Math.max(0, Math.min(turnsRemaining, 999)),
      toolStats: stats,
      composition: {
        systemPrompt: systemPromptTokens,
        messages: currentTokens - systemPromptTokens - toolResultTokens,
        toolResults: toolResultTokens,
      },
      totalTokens: currentTokens,
      modelLimit: this.modelLimit,
    };
  }

  /** Generate terse context hint for system prompt (only when >50% used) */
  getContextHint(currentTokens: number, systemPromptTokens: number): string | null {
    const snapshot = this.getSnapshot(currentTokens, systemPromptTokens);

    if (snapshot.usagePercent < 50) return null;

    const parts: string[] = [];
    parts.push(`[Context: ${snapshot.usagePercent}% used`);

    if (snapshot.turnsRemaining < 999) {
      parts.push(`~${snapshot.turnsRemaining} tool calls remaining`);
    }

    // Add retry warning if present
    const retryWarning = this.getRetryWarning();
    if (retryWarning) {
      parts.push(retryWarning);
    }

    if (snapshot.usagePercent > 75) {
      parts.push("prefer knowledge_search over re-reading files");
    }

    return parts.join(", ") + "]";
  }

  /** Get compression event data for WebSocket broadcast */
  getCompressionMetrics(): {
    totalCalls: number;
    totalSaved: number;
    totalIndexed: number;
    savingsRatio: number;
  } {
    let totalOriginal = 0;
    let totalCompressed = 0;
    let totalIndexed = 0;

    for (const stats of this.toolStats.values()) {
      totalOriginal += stats.totalOutputChars;
      totalCompressed += stats.totalCompressedChars;
      totalIndexed += stats.totalIndexed;
    }

    return {
      totalCalls: this.totalToolCalls,
      totalSaved: totalOriginal - totalCompressed,
      totalIndexed,
      savingsRatio: totalOriginal > 0 ? Math.round(((totalOriginal - totalCompressed) / totalOriginal) * 100) : 0,
    };
  }

  /** Reset tracker (e.g., on session restart) */
  reset(): void {
    this.toolStats.clear();
    this.recentTokensPerTurn = [];
    this.searchQueries.clear();
    this.totalToolCalls = 0;
  }
}
