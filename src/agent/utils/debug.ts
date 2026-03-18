/**
 * Debug Utilities
 *
 * Provides runtime-configurable debug logging.
 * Enabled via --debug flag or "debug": true in ~/.clawd/config.json.
 */

// Global debug state (set at runtime via setDebug)
let debugEnabled = false;

/**
 * Enable or disable debug mode at runtime
 */
export function setDebug(enabled: boolean): void {
  debugEnabled = enabled;
}

/**
 * Check if debug mode is enabled
 */
export function isDebugEnabled(): boolean {
  return debugEnabled;
}

/**
 * Log a debug message with category prefix
 */
export function debugLog(category: string, ...args: unknown[]): void {
  if (!debugEnabled) return;
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] [${category}]`, ...args);
}

/**
 * Log a debug message with JSON formatting
 */
export function debugLogJson(category: string, label: string, obj: unknown): void {
  if (!debugEnabled) return;
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] [${category}] ${label}:`);
  console.log(JSON.stringify(obj, null, 2));
}
