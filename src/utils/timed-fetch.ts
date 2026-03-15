/**
 * Shared fetch-with-timeout utility.
 *
 * Replaces the duplicated timedFetch / fetchWithTimeout pattern found
 * in worker-loop.ts, spawn-plugin.ts, worker-manager.ts, etc.
 */

/**
 * Fetch with an automatic abort timeout.
 *
 * NOTE: If `options.signal` is provided, it is composed with the timeout signal
 * via `AbortSignal.any()` so both the caller's signal and the timeout can abort
 * the request. If the runtime does not support `AbortSignal.any`, the caller's
 * signal is silently overridden by the timeout signal.
 *
 * @param url   Request URL
 * @param options  Standard RequestInit options
 * @param ms    Timeout in milliseconds (default: 10 000)
 */
export function timedFetch(url: string, options: RequestInit = {}, ms = 10_000): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);

  // Compose caller signal with timeout signal when possible
  let signal: AbortSignal = ctrl.signal;
  if (options.signal && typeof AbortSignal.any === "function") {
    signal = AbortSignal.any([ctrl.signal, options.signal]);
  }

  return fetch(url, { ...options, signal }).finally(() => clearTimeout(timer));
}
