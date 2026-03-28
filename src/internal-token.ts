/**
 * Internal service token — generated at startup, never persisted, changes on restart.
 * Used by worker-manager for internal HTTP self-calls (agents.list, agents.update).
 * Auth middleware accepts this token as valid for any channel.
 */
import { randomBytes } from "node:crypto";
export const INTERNAL_SERVICE_TOKEN: string = randomBytes(32).toString("hex");
