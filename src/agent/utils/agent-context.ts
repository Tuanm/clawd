/**
 * Agent Context - Per-agent isolated context using AsyncLocalStorage
 *
 * This solves the concurrent agent access conflict where global variables
 * (sandboxProjectRoot, projectHash) get overwritten when multiple agents
 * run simultaneously in clawd.
 *
 * Usage:
 *   // At agent entry point (worker-loop.ts):
 *   await runWithAgentContext({ projectRoot, projectHash }, async () => {
 *     await agent.run(prompt, sessionName);
 *   });
 *
 *   // In any code that needs context:
 *   const ctx = getAgentContext();
 *   const root = ctx?.projectRoot;  // "" when no context — no CWD fallback
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
  /** Session ID for read-once cache scoping */
  sessionId?: string;
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
 * Get the project root from the current agent context.
 * In worktree mode, this returns the worktree path (agent's working directory).
 *
 * Returns "" when no context is active. Callers must handle the empty case —
 * there is deliberately no process.cwd() fallback because the server's launch
 * directory is never a valid project root for any agent running inside it.
 */
export function getContextProjectRoot(): string {
  const ctx = getAgentContext();
  return ctx?.projectRoot || "";
}

/**
 * Get the original project root (never the worktree path).
 * Use this for .clawd/ config paths (files, agents, tools, skills) which
 * must always reference the real project, not the worktree copy.
 *
 * Resolution order: originalProjectRoot → projectRoot → channel-default.
 * Returns "" when none of those are set. No CWD fallback (see above).
 */
export function getContextConfigRoot(): string {
  const ctx = getAgentContext();
  if (ctx?.originalProjectRoot) return ctx.originalProjectRoot;
  if (ctx?.projectRoot) return ctx.projectRoot;
  // Fallback: channel-based default project root
  if (ctx?.channel) {
    const { homedir } = require("node:os");
    const { join } = require("node:path");
    return join(homedir(), ".clawd", "projects", ctx.channel);
  }
  return "";
}

/**
 * Strict variant of getContextProjectRoot — throws when no context is active.
 * Use from call sites where running without a registered project root is a
 * programming error (rather than silently falling back to a wrong path).
 */
export function requireContextProjectRoot(): string {
  const root = getContextProjectRoot();
  if (!root) {
    throw new Error(
      "requireContextProjectRoot: no agent context set. " +
        "This code must run inside runWithAgentContext(...) or receive an explicit projectRoot.",
    );
  }
  return root;
}

/**
 * Strict variant of getContextConfigRoot — throws when no context is active.
 */
export function requireContextConfigRoot(): string {
  const root = getContextConfigRoot();
  if (!root) {
    throw new Error(
      "requireContextConfigRoot: no agent context set. " +
        "This code must run inside runWithAgentContext(...) or receive an explicit projectRoot.",
    );
  }
  return root;
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

/**
 * Get the session ID from context.
 * Returns empty string if not in a context.
 */
export function getContextSessionId(): string {
  const ctx = getAgentContext();
  return ctx?.sessionId || "";
}

/**
 * Set the session ID in the current agent context.
 * Call this after startSession() so that tool handlers can access sessionId.
 * Silently no-ops if not in a context (safe to call from anywhere).
 */
export function setAgentSessionId(sessionId: string): void {
  const ctx = getAgentContext();
  if (ctx) {
    // The store IS mutable — objects are passed by reference
    ctx.sessionId = sessionId;
  }
}
