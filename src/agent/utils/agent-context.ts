/**
 * Agent Context - Per-agent isolated context using AsyncLocalStorage
 *
 * This solves the concurrent agent access conflict where global variables
 * (sandboxProjectRoot, projectHash) get overwritten when multiple agents
 * run simultaneously in clawd-app.
 *
 * Usage:
 *   // At agent entry point (worker-loop.ts):
 *   await runWithAgentContext({ projectRoot, projectHash }, async () => {
 *     await agent.run(prompt, sessionName);
 *   });
 *
 *   // In any code that needs context:
 *   const ctx = getAgentContext();
 *   const root = ctx?.projectRoot || process.cwd();
 */

import { AsyncLocalStorage } from "node:async_hooks";

export interface AgentContext {
  /** Project root directory for this agent's sandbox */
  projectRoot: string;
  /** Project hash for data isolation (agents, jobs directories) */
  projectHash: string;
  /** Agent ID (optional, for logging/debugging) */
  agentId?: string;
  /** Channel ID (optional, for logging/debugging) */
  channel?: string;
  /** LLM provider type (e.g., "copilot", "openai", "anthropic") */
  provider?: string;
  /** Git worktree path (undefined = not using worktree isolation) */
  worktreePath?: string;
  /** Git worktree branch name, e.g., "clawd/a3f7b2" */
  worktreeBranch?: string;
  /** Original project root before worktree (for diff base / sandbox .git mount) */
  originalProjectRoot?: string;
}

// AsyncLocalStorage instance - automatically propagates through async calls
const agentContextStorage = new AsyncLocalStorage<AgentContext>();

/**
 * Run a function with agent context.
 * All code executed within the callback (including async operations)
 * will have access to this context via getAgentContext().
 *
 * @param context - The agent context to use
 * @param fn - Async function to execute within the context
 * @returns The result of the function
 */
export function runWithAgentContext<T>(context: AgentContext, fn: () => T | Promise<T>): T | Promise<T> {
  return agentContextStorage.run(context, fn);
}

/**
 * Get the current agent context.
 * Returns undefined if called outside of runWithAgentContext().
 *
 * @returns The current agent context, or undefined
 */
export function getAgentContext(): AgentContext | undefined {
  return agentContextStorage.getStore();
}

/**
 * Get the project root from context, falling back to process.cwd().
 * This is a convenience function for the common case.
 */
export function getContextProjectRoot(): string {
  const ctx = getAgentContext();
  return ctx?.projectRoot || process.cwd();
}

/**
 * Get the project hash from context.
 * Returns empty string if not in a context (will trigger auto-generation in tools.ts).
 */
export function getContextProjectHash(): string {
  const ctx = getAgentContext();
  return ctx?.projectHash || "";
}

/**
 * Get the agent ID from context.
 * Returns empty string if not in a context.
 */
export function getContextAgentId(): string {
  const ctx = getAgentContext();
  return ctx?.agentId || "";
}

/**
 * Get the channel from context.
 * Returns empty string if not in a context.
 */
export function getContextChannel(): string {
  const ctx = getAgentContext();
  return ctx?.channel || "";
}

/**
 * Get the provider type from context.
 * Returns empty string if not in a context.
 */
export function getContextProvider(): string {
  const ctx = getAgentContext();
  return ctx?.provider || "";
}
