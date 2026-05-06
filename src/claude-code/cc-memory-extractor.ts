/**
 * CC Memory Extractor — auto-extract decisions, facts, and lessons from tool outputs.
 *
 * Pattern-based extraction that analyzes tool results and saves relevant
 * information to AgentMemoryStore for cross-session persistence.
 *
 * Extraction patterns:
 * - Decisions: "decided to use X", "chose Y over Z", "going with approach X"
 * - Facts: "X is Y", "X uses Y", learned "that X..."
 * - Lessons: "learned that", "discovered that", "figured out X"
 * - Corrections: "fixed by", "the issue was", "turns out X"
 */

import type { AgentMemoryStore, MemorySaveInput } from "../agent/memory/agent-memory";

// ── Extraction Patterns ─────────────────────────────────────────────────────

interface ExtractionPattern {
  category: "decision" | "fact" | "lesson" | "correction";
  pattern: RegExp;
  extract: (match: RegExpMatchArray, context: string) => { content: string; priority: number };
}

const EXTRACTION_PATTERNS: ExtractionPattern[] = [
  // Decisions
  {
    category: "decision",
    pattern:
      /(?:decided to|chose to?|going with|selected|opted for|will use|use\s+)([A-Z][^.]+?)(?:\s+instead|\s+over|\s+because|\s+since|\s+\.)/gi,
    extract: (m) => ({
      content: `Decided: ${m[1].trim()}`,
      priority: 60,
    }),
  },
  {
    category: "decision",
    pattern: /(?:the plan is to|plan:?\s*)(.+?)(?:\.|$)/gi,
    extract: (m) => ({
      content: `Plan: ${m[1].trim()}`,
      priority: 55,
    }),
  },
  {
    category: "decision",
    pattern: /(?:better to|should|might be better to|recommend(?:ing)?)\s+(.+?)(?:\.|$)/gi,
    extract: (m) => ({
      content: `Recommendation: ${m[1].trim()}`,
      priority: 50,
    }),
  },

  // Facts
  {
    category: "fact",
    pattern:
      /(?:the|this|that)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)*)\s+(?:is|uses?|uses?\s+[A-Z]|uses?\s+the|has|contains|returns?)\s+([^.]+?)(?:\.|$)/gi,
    extract: (m) => ({
      content: `${m[1].trim()}: ${m[2].trim()}`,
      priority: 40,
    }),
  },
  {
    category: "fact",
    pattern: /(?:learned that|found that|discovered that|noticed that)\s+(.+?)(?:\.|$)/gi,
    extract: (m) => ({
      content: `Fact: ${m[1].trim()}`,
      priority: 45,
    }),
  },

  // Lessons
  {
    category: "lesson",
    pattern: /(?:learned that|learned:)\s*(.+?)(?:\.|$)/gi,
    extract: (m) => ({
      content: `Lesson: ${m[1].trim()}`,
      priority: 55,
    }),
  },
  {
    category: "lesson",
    pattern: /(?:figured out|found out|worked out)\s+(?:that\s+)?(.+?)(?:\.|$)/gi,
    extract: (m) => ({
      content: `Discovery: ${m[1].trim()}`,
      priority: 50,
    }),
  },
  {
    category: "lesson",
    pattern: /(?:important to remember|remember to|don't forget)\s+(.+?)(?:\.|$)/gi,
    extract: (m) => ({
      content: `Reminder: ${m[1].trim()}`,
      priority: 60,
    }),
  },

  // Corrections
  {
    category: "correction",
    pattern: /(?:fixed by|fix:?\s*)(.+?)(?:\.|$)/gi,
    extract: (m) => ({
      content: `Fix: ${m[1].trim()}`,
      priority: 70,
    }),
  },
  {
    category: "correction",
    pattern: /(?:the issue was|problem was|bug was|error was)\s+(.+?)(?:\.|$)/gi,
    extract: (m) => ({
      content: `Root cause: ${m[1].trim()}`,
      priority: 65,
    }),
  },
  {
    category: "correction",
    pattern: /(?:turns out|actually|in fact)\s+(.+?)(?:\.|$)/gi,
    extract: (m) => ({
      content: `Correction: ${m[1].trim()}`,
      priority: 55,
    }),
  },
];

// Decision phrases that indicate a significant decision was made
const DECISION_INDICATORS = [
  "decided",
  "chose",
  "going with",
  "selected",
  "opted",
  "best approach",
  "will use",
  "let's use",
  "use this",
  "adopt",
  "implement with",
  "go with",
];

// ── Memory Extractor Class ───────────────────────────────────────────────────

export class CCMemoryExtractor {
  private store: AgentMemoryStore;
  private agentId: string;
  private channel: string;
  private projectRoot: string;
  private lastExtractionAt = 0;
  private readonly MIN_EXTRACTION_INTERVAL_MS = 5000; // At most once every 5s
  private readonly MAX_EXTRACTIONS_PER_TURN = 3;

  constructor(store: AgentMemoryStore, agentId: string, channel: string, projectRoot: string) {
    this.store = store;
    this.agentId = agentId;
    this.channel = channel;
    this.projectRoot = projectRoot;
  }

  /**
   * Extract memories from a tool result.
   * Returns the number of extractions performed.
   */
  extractFromToolResult(toolName: string, args: any, result: any): number {
    const now = Date.now();
    if (now - this.lastExtractionAt < this.MIN_EXTRACTION_INTERVAL_MS) {
      return 0;
    }

    const output = this.extractOutput(result);
    if (!output || output.length < 20) return 0; // Skip short/empty outputs

    const context = this.buildContext(toolName, args, output);
    const extractions = this.findExtractions(output, context);

    if (extractions.length === 0) return 0;

    let saved = 0;
    for (const ext of extractions.slice(0, this.MAX_EXTRACTIONS_PER_TURN)) {
      try {
        this.saveMemory(ext);
        saved++;
      } catch (err) {
        console.error("[CCMemoryExtractor] Failed to save memory:", err);
      }
    }

    if (saved > 0) {
      this.lastExtractionAt = now;
    }

    return saved;
  }

  /**
   * Extract a decision from assistant text (e.g., "I'll use X approach")
   */
  extractDecision(text: string): void {
    const lower = text.toLowerCase();

    // Check if text contains decision indicators
    const hasIndicator = DECISION_INDICATORS.some((ind) => lower.includes(ind));
    if (!hasIndicator) return;

    // Try to extract the decision
    for (const pattern of EXTRACTION_PATTERNS) {
      if (pattern.category !== "decision") continue;
      const matches = [...text.matchAll(pattern.pattern)];
      for (const match of matches.slice(0, 1)) {
        const { content, priority } = pattern.extract(match, text);
        try {
          this.saveMemory({ content, category: "decision", priority });
        } catch (err) {
          console.error("[CCMemoryExtractor] Failed to save decision:", err);
        }
      }
    }
  }

  /**
   * Save a memory to the store
   */
  private saveMemory(input: { content: string; category?: string; priority?: number }): void {
    const saveInput: MemorySaveInput = {
      agentId: this.agentId,
      channel: this.channel,
      content: input.content.slice(0, 500),
      category: (input.category as any) || "fact",
      source: "auto",
      priority: input.priority || 40,
    };

    this.store.save(saveInput);
  }

  /**
   * Find all extractions in text
   */
  private findExtractions(
    text: string,
    context: string,
  ): Array<{ content: string; category: string; priority: number }> {
    const results: Array<{ content: string; category: string; priority: number }> = [];
    const seen = new Set<string>();

    for (const pattern of EXTRACTION_PATTERNS) {
      const matches = [...text.matchAll(pattern.pattern)];
      for (const match of matches.slice(0, 2)) {
        // Limit per pattern
        const { content, priority } = pattern.extract(match, context);
        const normalized = content.toLowerCase().slice(0, 100);

        if (seen.has(normalized)) continue;
        seen.add(normalized);

        results.push({
          content,
          category: pattern.category,
          priority,
        });
      }
    }

    return results;
  }

  /**
   * Extract output string from tool result
   */
  private extractOutput(result: any): string | null {
    if (!result) return null;
    if (typeof result === "string") return result;
    if (typeof result === "object") {
      // Handle various result formats
      if (result.output) return String(result.output);
      if (result.content) return String(result.content);
      if (result.stdout) return String(result.stdout);
      if (result.stderr) return String(result.stderr);
      if (result.error) return String(result.error);
      if (result.results) {
        if (Array.isArray(result.results)) {
          return result.results
            .map((r: any) => this.extractOutput(r))
            .filter(Boolean)
            .join("\n");
        }
        return String(result.results);
      }
    }
    return null;
  }

  /**
   * Build context string from tool name and args
   */
  private buildContext(toolName: string, args: any, output: string): string {
    const parts: string[] = [];
    if (toolName) parts.push(`Tool: ${toolName}`);

    if (args) {
      if (typeof args === "object") {
        const path = args.path || args.file || args.file_path || args.url || null;
        if (path) parts.push(`Target: ${path}`);
      } else if (typeof args === "string") {
        const parsed = tryParseJson(args);
        if (parsed) {
          const path = parsed.path || parsed.file || parsed.url || null;
          if (path) parts.push(`Target: ${path}`);
        }
      }
    }

    if (parts.length > 0) {
      return `${parts.join(", ")}\nOutput: ${output.slice(0, 200)}`;
    }
    return output.slice(0, 200);
  }
}

// ── Helpers ────────────────────────────────────────────────────────────────

function tryParseJson(text: string): any | null {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
