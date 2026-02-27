/**
 * Centralized context window thresholds.
 *
 * When contextMode=true, thresholds scale dynamically with the model's
 * token limit. When contextMode=false, legacy hardcoded values are used.
 */

export const MODEL_TOKEN_LIMITS: Record<string, number> = {
  "claude-opus-4.6": 128000,
  "claude-opus-4.5": 128000,
  "claude-sonnet-4.5": 128000,
  "claude-sonnet-4": 128000,
  "claude-haiku-4.5": 128000,
  "gpt-5": 128000,
  "gpt-5.1": 128000,
  "gpt-5.2": 128000,
  "gpt-4.1": 128000,
};

export interface ContextThresholds {
  /** Token count at which to create a proactive checkpoint */
  checkpoint: number;
  /** Token count at which to compact (keep important messages) */
  warning: number;
  /** Token count at which to do emergency reset */
  critical: number;
  /** Raw model token limit */
  modelLimit: number;
  /** Effective budget (80% of model limit) */
  effective: number;
}

// Legacy hardcoded values (contextMode=false)
const LEGACY_CHECKPOINT = 32000;
const LEGACY_WARNING = 50000;
const LEGACY_CRITICAL = 70000;

/**
 * Get context thresholds for a model.
 * When contextMode=true, scales dynamically with model size.
 * When contextMode=false, returns legacy hardcoded values.
 */
export function getThresholds(model: string, contextMode: boolean): ContextThresholds {
  const modelLimit = MODEL_TOKEN_LIMITS[model] ?? 128000;
  const effective = Math.floor(modelLimit * 0.8);

  if (!contextMode) {
    return {
      checkpoint: LEGACY_CHECKPOINT,
      warning: LEGACY_WARNING,
      critical: LEGACY_CRITICAL,
      modelLimit,
      effective,
    };
  }

  return {
    checkpoint: Math.floor(effective * 0.5),
    warning: Math.floor(effective * 0.7),
    critical: Math.floor(effective * 0.85),
    modelLimit,
    effective,
  };
}

/** Safety margin: if estimated tokens > 95% of raw model limit, hard-reject */
export function exceedsSafetyMargin(estimatedTokens: number, model: string): boolean {
  const modelLimit = MODEL_TOKEN_LIMITS[model] ?? 128000;
  return estimatedTokens > modelLimit * 0.95;
}
