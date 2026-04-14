/**
 * Skill Review Plugin — Auto-wiring configuration
 *
 * This file enables automatic plugin registration via the plugin system.
 * Import this module to register the skill-review plugin with the Agent.
 */

import type { Plugin } from "./manager";

export interface SkillReviewPluginOptions {
  /** Tool call interval between reviews (default: 20) */
  reviewInterval?: number;
  /** Minimum tool calls before first review (default: 10) */
  minToolCallsBeforeFirstReview?: number;
  /** Model for review agent (default: inherit parent's model) */
  reviewModel?: string;
  /** Max skills to create per review (default: 2) */
  maxSkillsPerReview?: number;
  /** Cooldown between reviews in ms (default: 300000 = 5 min) */
  reviewCooldownMs?: number;
  /** Claw'd API server URL — required for posting channel notifications */
  apiUrl: string;
  /** Channel ID to post skill notifications */
  channel: string;
  /** Project root for skill storage (optional, auto-detected if not provided) */
  projectRoot?: string;
}

// Re-export for convenience
export type { SkillReviewConfig, SkillReviewDeps } from "./skill-review-plugin";

/**
 * Creates the skill-review plugin instance with the given options.
 *
 * @example
 * ```typescript
 * import { createSkillReviewPlugin } from "./plugins/skill-review-plugin";
 * import { registerSkillReviewPlugin } from "./plugins/skill-review.config";
 *
 * // Option 1: Direct creation
 * const { plugin } = createSkillReviewPlugin({
 *   apiUrl: "http://localhost:3000",
 *   channel: "my-channel",
 *   reviewInterval: 20,
 * });
 *
 * // Option 2: With auto-wiring
 * const plugin = registerSkillReviewPlugin({
 *   apiUrl: "http://localhost:3000",
 *   channel: "my-channel",
 * });
 * ```
 */
export function registerSkillReviewPlugin(options: SkillReviewPluginOptions): {
  plugin: Plugin;
  options: SkillReviewPluginOptions;
} {
  // Dynamic import to avoid circular dependencies and allow lazy loading
  const { createSkillReviewPlugin } = require("./skill-review-plugin");

  const { plugin } = createSkillReviewPlugin(options);

  return { plugin, options };
}

/**
 * Default configuration values for the skill-review plugin.
 * Can be overridden via environment variables or config file.
 */
export const DEFAULT_SKILL_REVIEW_CONFIG: Partial<SkillReviewPluginOptions> = {
  reviewInterval: parseInt(process.env.CLAWD_SKILL_REVIEW_INTERVAL ?? "20", 10),
  minToolCallsBeforeFirstReview: parseInt(process.env.CLAWD_SKILL_REVIEW_MIN_TOOLS ?? "10", 10),
  maxSkillsPerReview: parseInt(process.env.CLAWD_SKILL_REVIEW_MAX_SKILLS ?? "2", 10),
  reviewCooldownMs: parseInt(process.env.CLAWD_SKILL_REVIEW_COOLDOWN_MS ?? "300000", 10),
};

/**
 * Check if skill review is enabled via environment or config.
 */
export function isSkillReviewEnabled(): boolean {
  // Check for explicit disable
  if (process.env.CLAWD_SKILL_REVIEW_ENABLED === "false") {
    return false;
  }
  // Check for API URL (required for plugin to function)
  if (!process.env.CLAWD_API_URL) {
    return false;
  }
  return true;
}

/**
 * Load skill review config from environment variables.
 * Returns null if skill review is not enabled.
 */
export function loadSkillReviewConfigFromEnv(): SkillReviewPluginOptions | null {
  if (!isSkillReviewEnabled()) {
    return null;
  }

  return {
    apiUrl: process.env.CLAWD_API_URL!,
    channel: process.env.CLAWD_CHANNEL ?? "default",
    reviewInterval: DEFAULT_SKILL_REVIEW_CONFIG.reviewInterval,
    minToolCallsBeforeFirstReview: DEFAULT_SKILL_REVIEW_CONFIG.minToolCallsBeforeFirstReview,
    maxSkillsPerReview: DEFAULT_SKILL_REVIEW_CONFIG.maxSkillsPerReview,
    reviewCooldownMs: DEFAULT_SKILL_REVIEW_CONFIG.reviewCooldownMs,
    reviewModel: process.env.CLAWD_SKILL_REVIEW_MODEL,
    projectRoot: process.env.CLAWD_PROJECT_ROOT,
  };
}
