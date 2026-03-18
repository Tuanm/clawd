/**
 * Async call context — carries agent/channel identity through the async call chain
 * so analytics can tag each Copilot API call with its origin without passing extra params.
 */
import { AsyncLocalStorage } from "node:async_hooks";

export interface CallCtx {
  agentId?: string;
  channel?: string;
}

export const callContext = new AsyncLocalStorage<CallCtx>();
