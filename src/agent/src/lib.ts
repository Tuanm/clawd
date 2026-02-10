export { CopilotClient, getToken } from "./api/client";
export type {
  Message,
  ToolCall,
  ToolDefinition,
  CompletionRequest,
  CompletionResponse,
  StreamEvent,
} from "./api/client";

export { SessionManager } from "./session/manager";
export type { Session, StoredMessage } from "./session/manager";

export { toolDefinitions, tools, executeTool, executeTools, executeToolsArray } from "./tools/tools";
export type { ToolResult, ToolHandler } from "./tools/tools";

export { Agent } from "./agent/agent";
export type { AgentConfig, AgentResult, InterruptChecker } from "./agent/agent";

export { MemoryManager, estimateTokens, estimateMessagesTokens } from "./memory/memory";
export type { MemoryQuery, MemoryEntry, MemorySummary } from "./memory/memory";

export { JobManager, jobManager } from "./jobs/manager";
export type { Job, JobStatus, JobTask } from "./jobs/manager";

export { TmuxJobManager, tmuxJobManager } from "./jobs/tmux-manager";
export type { Job as TmuxJob, JobStatus as TmuxJobStatus } from "./jobs/tmux-manager";

export { SubAgent, spawnAgent } from "./subagent/subagent";
export type { SubAgentConfig, SubAgentResult, SubAgentStatus } from "./subagent/subagent";

export { MCPManager, mcpManager } from "./mcp/client";
export type { MCPServerConfig, MCPTool, MCPResource, MCPPrompt } from "./mcp/client";

export { SkillManager, getSkillManager } from "./skills/manager";
export type { Skill, SkillMetadata, SkillMatch } from "./skills/manager";

export { PluginManager, createClawdChatPlugin } from "./plugins/index";
export type { Plugin, PluginHooks, PluginContext, ClawdChatConfig } from "./plugins/index";

export { setCurrentAgentId } from "./tools/tools";
