/**
 * Agents routes barrel — re-exports both management CRUD and status/polling handlers.
 */

export { getAgentProjectRoot, initAgentsTable, registerAgentRoutes } from "./crud";
export { handleAgentStatusRoutes } from "./status";
