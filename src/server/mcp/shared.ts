/**
 * Shared mutable state for MCP handlers.
 * Exports live bindings — mutations from setters are visible to all importers.
 */

import type { SchedulerManager } from "../../scheduler/manager";
import type { WorkerManager } from "../../worker-manager";

// Scheduler reference (set by index.ts after creation)
export let _scheduler: SchedulerManager | null = null;
export function setMcpScheduler(scheduler: SchedulerManager): void {
  _scheduler = scheduler;
}

// WorkerManager reference (set by index.ts after creation — used by handleAgentMcpRequest)
export let _workerManager: WorkerManager | null = null;
export function setMcpWorkerManager(wm: WorkerManager): void {
  _workerManager = wm;
}

/**
 * Callback registry for Claude Code space workers.
 * When a Claude Code subprocess calls complete_task via MCP,
 * the handler looks up the resolve callback here.
 */
export const spaceCompleteCallbacks = new Map<string, (result: string) => void>();

/** Per-space auth tokens — validated on every MCP and hook API request */
export const spaceAuthTokens = new Map<string, string>();

/** Per-space project roots — populated by ClaudeCodeSpaceWorker before runSDKQuery */
export const spaceProjectRoots = new Map<string, string>();
