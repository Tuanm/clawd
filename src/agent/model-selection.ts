/**
 * Model Selection Logic
 *
 * Determines which LLM model to use for each agent iteration.
 * Pure functions — no side effects, no state mutation.
 */

import type { LLMProvider } from "./api/providers";

/**
 * Get the model name from a provider instance, falling back to the configured model.
 */
export function resolveModel(client: LLMProvider, configModel: string): string {
  if (client && "model" in client) {
    const m = (client as any).model;
    if (m) return m;
  }
  return configModel || "claude-sonnet-4.5";
}

/**
 * Determine the model to use for the current iteration.
 * Downgrades to fastModel for pure tool-routing iterations to reduce costs.
 *
 * Downgrade conditions (ALL must be true):
 * - iteration > 2 (first 2 always use full model for task understanding)
 * - toolResultPending is false (full model needed to process tool results)
 * - afterCompaction is false (need full model to re-orient after compaction)
 * - userMessage does not contain reasoning keywords
 * - last N iterations were ALL pure tool calls (no substantive text content)
 */
export function resolveIterationModel(
  fullModel: string,
  fastModel: string,
  iteration: number,
  iterationContentHistory: string[],
  toolResultPending: boolean,
  afterCompaction: boolean,
  userMessage: string,
  verbose?: boolean,
): string {
  // Always use full model for first 2 iterations
  if (iteration <= 2) {
    if (verbose) {
      console.log(`[Agent] Model: ${fullModel} (full reasoning)`);
    }
    return fullModel;
  }

  // Always use full model when tool results are pending
  if (toolResultPending) {
    if (verbose) {
      console.log(`[Agent] Model: ${fullModel} (full reasoning)`);
    }
    return fullModel;
  }

  // Always use full model immediately after compaction
  if (afterCompaction) {
    if (verbose) {
      console.log(`[Agent] Model: ${fullModel} (full reasoning)`);
    }
    return fullModel;
  }

  // Always use full model for reasoning-heavy requests
  const reasoningKeywords = /\b(explain|why|analyze|analyse|design|understand|reason|think|consider|evaluate)\b/i;
  if (reasoningKeywords.test(userMessage)) {
    if (verbose) {
      console.log(`[Agent] Model: ${fullModel} (full reasoning)`);
    }
    return fullModel;
  }

  // Check if last N iterations were pure tool calls (no substantive text >50 chars)
  const PURE_TOOL_WINDOW = 3;
  const recentHistory = iterationContentHistory.slice(-PURE_TOOL_WINDOW);
  if (recentHistory.length < PURE_TOOL_WINDOW) {
    if (verbose) {
      console.log(`[Agent] Model: ${fullModel} (full reasoning)`);
    }
    return fullModel;
  }

  const allPureToolCalls = recentHistory.every((c) => c.length < 50);
  if (allPureToolCalls) {
    if (verbose) {
      console.log(`[Agent] Model: ${fastModel} (downgraded: tool-routing)`);
    }
    return fastModel;
  }

  if (verbose) {
    console.log(`[Agent] Model: ${fullModel} (full reasoning)`);
  }
  return fullModel;
}
