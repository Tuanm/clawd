/**
 * Constants for spaces feature — replaces inline magic numbers.
 */

/** Default API port for space agents */
export const DEFAULT_API_PORT = "3456";

/** Default agent timeout in seconds (30 minutes) */
export const DEFAULT_AGENT_TIMEOUT_SECONDS = 1800;

/** Default spawn timeout in seconds (10 minutes) */
export const DEFAULT_SPAWN_TIMEOUT_SECONDS = 600;

/** Max context length passed to spawned agents */
export const MAX_CONTEXT_LENGTH = 4000;

/** Max result length before truncation in plugin */
export const MAX_RESULT_LENGTH = 10000;

/** Retry backoff base in ms */
export const RETRY_BACKOFF_MS = 5000;

/** Health check interval in ms */
export const HEALTH_CHECK_INTERVAL_MS = 2000;

/** Eviction timer for tracked spaces (30 minutes) */
export const SPACE_EVICTION_MS = 30 * 60 * 1000;

/** Default agent avatar color */
export const DEFAULT_AGENT_COLOR = "#D97706";

/** Default spawn agent avatar color */
export const DEFAULT_SPAWN_AGENT_COLOR = "#6366f1";

/** Maximum active sub-agents per channel */
export const MAX_ACTIVE_SUB_AGENTS = 9;
