#!/usr/bin/env bun
/**
 * Claw'd - Autonomous AI Agent CLI
 *
 * A lightweight, fast AI agent using GitHub Copilot API.
 */

import { Agent, type AgentConfig } from "./agent/agent";
import { getToken } from "./api/client";
import { getSessionManager } from "./session/manager";
import { MCPManager } from "./mcp/client";
import { tools, toolDefinitions, setProjectHash } from "./tools/tools";
import { initializeSandbox } from "./utils/sandbox";
import type { ToolDefinition } from "./api/client";
import { API_URL, API_PATH } from "./api/config";
import { setDebug } from "./utils/debug";
import { appendFileSync, writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";

// ============================================================================
// Sandbox Initialization
// ============================================================================

async function initSandbox(yolo: boolean) {
  // Enable sandbox unless --yolo
  // Sub-agents inherit their cwd from parent (set during spawn), so they
  // automatically get sandboxed to the correct project root.
  const projectRoot = process.cwd();
  await initializeSandbox(projectRoot, yolo);
}

// ============================================================================
// CLAWD.md Auto-Loading + Agent Identity
// ============================================================================

interface AgentIdentityConfig {
  roles?: string[];
  description?: string;
  directives?: string[];
  model?: string;
}

function loadAgentIdentity(projectRoot: string, agentId: string): string {
  const configPath = join(projectRoot, ".clawd", "agents.json");
  if (!existsSync(configPath)) return "";

  let config: Record<string, AgentIdentityConfig>;
  try {
    config = JSON.parse(readFileSync(configPath, "utf-8"));
  } catch (e) {
    console.error(`[Claw'd] Failed to parse .clawd/agents.json:`, e);
    return "";
  }

  const agent = config[agentId];
  if (!agent) {
    console.error(`[Claw'd] Agent "${agentId}" not found in .clawd/agents.json, skipping identity injection`);
    return "";
  }

  const sections: string[] = [];

  // 1. Own identity
  sections.push(`## Your Identity & Roles\n\nYou are "${agentId}". ${agent.description || ""}`);

  // 2. Standing directives (behavioral rules that persist across sessions)
  if (agent.directives && agent.directives.length > 0) {
    sections.push(
      `### Standing Directives\n\nThese are your standing behavioral rules. Follow them at ALL times, even after long conversations:\n\n${agent.directives.map((d: string) => `- ${d}`).join("\n")}`,
    );
  }

  // 3. Load detailed role files
  const rolesDir = join(projectRoot, ".clawd", "roles");
  for (const role of agent.roles || []) {
    const rolePath = join(rolesDir, `${role}.md`);
    if (existsSync(rolePath)) {
      try {
        const content = readFileSync(rolePath, "utf-8");
        sections.push(`### Role: ${role}\n\n${content}`);
      } catch {
        // Ignore read errors for individual role files
      }
    }
  }

  // 4. Summary of other agents (so this agent knows who else is available)
  const others = Object.entries(config)
    .filter(([name]) => name !== agentId)
    .map(([name, cfg]) => {
      const roles = cfg.roles?.join(", ") || "no roles";
      return `- "${name}" (roles: ${roles}): ${cfg.description || "No description"}`;
    });

  if (others.length > 0) {
    sections.push(`## Other Agents in This Project\n\n${others.join("\n")}`);
  }

  return sections.join("\n\n");
}

function loadClawdContext(agentId?: string): string {
  const contexts: string[] = [];
  const CLAWD_DIR = join(homedir(), ".clawd");
  const projectRoot = process.cwd();

  // 1. Global CLAWD.md from ~/.clawd/CLAWD.md
  const globalClawdPath = join(CLAWD_DIR, "CLAWD.md");
  if (existsSync(globalClawdPath)) {
    try {
      const content = readFileSync(globalClawdPath, "utf-8");
      contexts.push(`## Global Instructions (~/.clawd/CLAWD.md)\n\n${content}`);
    } catch {
      // Ignore read errors
    }
  }

  // 2. Project CLAWD.md from {projectRoot}/CLAWD.md
  const projectClawdPath = join(projectRoot, "CLAWD.md");
  if (existsSync(projectClawdPath) && projectClawdPath !== globalClawdPath) {
    try {
      const content = readFileSync(projectClawdPath, "utf-8");
      contexts.push(`## Project Instructions (${projectRoot}/CLAWD.md)\n\n${content}`);
    } catch {
      // Ignore read errors
    }
  }

  // 3. Agent identity from {projectRoot}/.clawd/agents.json
  if (agentId) {
    const identity = loadAgentIdentity(projectRoot, agentId);
    if (identity) {
      contexts.push(`# Agent Identity & Configuration\n\n${identity}`);
    }
  }

  if (contexts.length === 0) {
    return "";
  }

  return `\n\n# Agent Context\n\n${contexts.join("\n\n---\n\n")}`;
}

// ============================================================================
// MCP Config Auto-Loading
// ============================================================================

interface MCPConfigFile {
  mcpServers?: Record<
    string,
    {
      command: string;
      args?: string[];
      env?: Record<string, string>;
    }
  >;
}

// CLI MCP manager instance (only used in CLI mode, not shared with Agent)
const mcpManager = new MCPManager();

async function loadMCPConfigs(): Promise<void> {
  const CLAWD_DIR = join(homedir(), ".clawd");
  const projectRoot = process.cwd();
  const configs: string[] = [];

  // 1. Global MCP config from ~/.clawd/mcp.json
  const globalMcpPath = join(CLAWD_DIR, "mcp.json");
  if (existsSync(globalMcpPath)) {
    configs.push(globalMcpPath);
  }

  // 2. Project MCP config from .clawd/mcp.json
  const projectMcpPath = join(projectRoot, ".clawd", "mcp.json");
  if (existsSync(projectMcpPath)) {
    configs.push(projectMcpPath);
  }

  // Load and initialize each config
  for (const configPath of configs) {
    try {
      const content = readFileSync(configPath, "utf-8");
      const config: MCPConfigFile = JSON.parse(content);

      if (config.mcpServers) {
        for (const [name, server] of Object.entries(config.mcpServers)) {
          try {
            await mcpManager.addServer({
              name,
              command: server.command,
              args: server.args,
              env: server.env,
            });
            console.log(`[MCP] Loaded server: ${name} from ${configPath}`);
          } catch (err: any) {
            console.error(`[MCP] Failed to load server ${name}: ${err.message}`);
          }
        }
      }
    } catch (err: any) {
      console.error(`[MCP] Failed to parse ${configPath}: ${err.message}`);
    }
  }
}

// ============================================================================
// Output Writer (handles file output and tee mode)
// ============================================================================

class OutputWriter {
  private outputFile?: string;
  private tee: boolean;

  constructor(outputFile?: string, tee: boolean = false) {
    this.outputFile = outputFile;
    this.tee = tee;
    // Clear/create output file if specified
    if (this.outputFile) {
      writeFileSync(this.outputFile, "");
    }
  }

  write(text: string) {
    if (this.outputFile) {
      // Strip ANSI codes for file output
      const clean = text.replace(/\x1b\[[0-9;]*m/g, "");
      appendFileSync(this.outputFile, clean);
      if (this.tee) {
        process.stdout.write(text);
      }
    } else {
      process.stdout.write(text);
    }
  }

  writeLine(text: string) {
    this.write(`${text}\n`);
  }
}

// ============================================================================
// ANSI Colors
// ============================================================================

const c = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  magenta: "\x1b[35m",
  cyan: "\x1b[36m",
};

// ============================================================================
// CLI Parser
// ============================================================================

interface Args {
  prompt?: string;
  model: string;
  session?: string;
  resume?: string;
  agentId?: string; // Agent identity (loads from .clawd/agents.json)
  list: boolean;
  verbose: boolean;
  debug: boolean; // Enable debug logging
  help: boolean;
  chat: boolean;
  output?: string;
  tee: boolean;
  maxIterations: number;
  tokenLimitWarning?: number;
  tokenLimitCritical?: number;
  // Plugin configuration
  plugin?: string; // JSON config for plugin (e.g., clawd-chat)
  // Session management
  sessionStats?: string;
  sessionCompact?: string;
  sessionReset?: string;
  // Sub-agent result file (passed directly, not via env var)
  resultFile?: string;
  // Security
  yolo: boolean; // Disable sandbox restrictions
  // Project isolation
  projectHash?: string; // Project hash for data isolation
  // Subcommands
  serve: boolean; // Start proxy server
  servePort?: number; // Port for proxy server (from CLI)
  serveConfig?: string; // Config file path for serve
  serveDebug?: boolean; // Enable debug logging for serve
  serveIdleTimeout?: number; // Idle timeout in seconds
  serveRequestTimeout?: number; // Per-request timeout in seconds
}

function parseArgs(): Args {
  const args: Args = {
    model: "claude-opus-4.6",
    list: false,
    verbose: false,
    debug: false,
    help: false,
    chat: false,
    tee: false,
    maxIterations: 10,
    yolo: false,
    serve: false,
  };

  const argv = process.argv.slice(2);

  // Check for subcommand first
  if (argv[0] === "serve") {
    args.serve = true;
    // Parse serve-specific args
    for (let i = 1; i < argv.length; i++) {
      const arg = argv[i];
      if (arg === "-p" || arg === "--port") {
        const port = parseInt(argv[++i], 10);
        if (!isNaN(port)) args.servePort = port;
      } else if (arg === "-c" || arg === "--config") {
        args.serveConfig = argv[++i];
      } else if (arg === "-h" || arg === "--help") {
        args.help = true;
      } else if (arg === "-d" || arg === "--debug") {
        args.serveDebug = true;
      } else if (arg === "--idle-timeout") {
        const timeout = parseInt(argv[++i], 10);
        if (!isNaN(timeout)) args.serveIdleTimeout = timeout;
      } else if (arg === "--request-timeout") {
        const timeout = parseInt(argv[++i], 10);
        if (!isNaN(timeout)) args.serveRequestTimeout = timeout;
      }
    }
    return args;
  }

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];

    switch (arg) {
      case "-p":
      case "--prompt":
        args.prompt = argv[++i];
        break;
      case "-m":
      case "--model":
        args.model = argv[++i];
        break;
      case "-s":
      case "--session":
        args.session = argv[++i];
        break;
      case "-r":
      case "--resume":
        args.resume = argv[++i];
        break;
      case "-i":
      case "--id":
        args.agentId = argv[++i];
        break;
      case "--max-iterations": {
        const parsed = parseInt(argv[++i], 10);
        args.maxIterations = Number.isNaN(parsed) ? 10 : parsed; // 0 means unlimited
        break;
      }
      case "--token-limit-warning":
        args.tokenLimitWarning = parseInt(argv[++i], 10);
        break;
      case "--token-limit-critical":
        args.tokenLimitCritical = parseInt(argv[++i], 10);
        break;
      case "-l":
      case "--list":
        args.list = true;
        break;
      case "-v":
      case "--verbose":
        args.verbose = true;
        break;
      case "-d":
      case "--debug":
        args.debug = true;
        break;
      case "-c":
      case "--chat":
        args.chat = true;
        break;
      case "-h":
      case "--help":
        args.help = true;
        break;
      case "-o":
      case "--output":
        args.output = argv[++i];
        break;
      case "-t":
      case "--tee":
        args.tee = true;
        break;
      case "--session-stats":
        args.sessionStats = argv[++i];
        break;
      case "--session-compact":
        args.sessionCompact = argv[++i];
        break;
      case "--session-reset":
        args.sessionReset = argv[++i];
        break;
      case "--plugin":
        args.plugin = argv[++i];
        break;
      case "--result-file":
        args.resultFile = argv[++i];
        break;
      case "--project-hash":
        args.projectHash = argv[++i];
        break;
      case "--yolo":
        args.yolo = true;
        // YOLO mode = unlimited iterations
        args.maxIterations = 0;
        break;
      default:
        if (!arg.startsWith("-") && !args.prompt) {
          args.prompt = arg;
        }
    }
  }

  return args;
}

// ============================================================================
// Help
// ============================================================================

function showHelp() {
  console.log(`
${c.bold}${c.cyan}Claw'd${c.reset} - Autonomous AI Agent

${c.bold}Usage:${c.reset}
  clawd -p "your prompt"     Run agent with a prompt
  clawd --chat               Interactive chat mode
  clawd --list               List sessions
  clawd serve                Start API proxy server

${c.bold}Commands:${c.reset}
  serve                      Start Copilot API proxy server
    --port, -p <port>        Port to listen on (default: 3456)

${c.bold}Options:${c.reset}
  -p, --prompt <text>        The prompt to send
  -m, --model <model>        Model to use (default: claude-opus-4.6)
  -s, --session <name>       Session name (creates/resumes)
  -r, --resume <id|name>     Resume session by ID or name
  -i, --id <agent_id>        Agent identity (loads from .clawd/agents.json)
  --max-iterations <n>       Max agentic loop iterations (default: 10, 0=unlimited)
  -o, --output <file>        Write output to file
  -t, --tee                  With -o, also print to stdout
  --plugin <json>            Plugin config (e.g., clawd-chat)
  --result-file <path>       Write final result JSON to file (for sub-agents)
  --project-hash <hash>      Project hash for data isolation (auto-generated if not set)
  --yolo                     Disable sandbox + unlimited iterations
  -l, --list                 List recent sessions
  -c, --chat                 Interactive chat mode
  -v, --verbose              Show tool execution details
  -d, --debug                Enable debug logging (API, hooks, etc.)
  -h, --help                 Show this help

${c.bold}Session Management:${c.reset}
  --session-stats <name>     Show session size statistics
  --session-compact <name>   Compact session (keep recent 30 messages)
  --session-reset <name>     Reset session (delete all messages)

${c.bold}Models:${c.reset}
  ${c.green}Free:${c.reset}      gpt-4.1, gpt-5-mini
  ${c.yellow}Standard:${c.reset}  claude-sonnet-4, gpt-5, gpt-5.1, gpt-5.2
  ${c.magenta}Premium:${c.reset}   claude-opus-4.6 (3x), claude-opus-4.5 (3x)
  ${c.dim}Economy:${c.reset}   claude-haiku-4.5 (0.33x)

${c.bold}Security:${c.reset}
  By default, file operations are restricted to:
  - Current directory (project root)
  - /tmp
  Use --yolo to disable restrictions and run with unlimited iterations.

${c.bold}Examples:${c.reset}
  clawd -p "List all TypeScript files"
  clawd -p "Fix the bug in main.ts" -m claude-opus-4.6
  clawd -s myproject -p "Explain this codebase"
  clawd --chat -s coding
  clawd serve --port 8080
  clawd --session-stats myproject
`);
}

// ============================================================================
// List Sessions
// ============================================================================

function listSessions() {
  const sessions = getSessionManager();
  const list = sessions.listSessions(20);
  // Don't close singleton

  if (list.length === 0) {
    console.log(`${c.dim}No sessions found${c.reset}`);
    return;
  }

  console.log(`${c.bold}Recent Sessions:${c.reset}\n`);

  for (const s of list) {
    const date = new Date(s.updated_at).toLocaleString();
    console.log(`  ${c.cyan}${s.id.slice(0, 8)}${c.reset}  ${s.name}  ${c.dim}${s.model}  ${date}${c.reset}`);
  }
}

// ============================================================================
// Session Management Commands
// ============================================================================

function showSessionStats(name: string) {
  const manager = getSessionManager();
  const stats = manager.getSessionStatsByName(name);
  // Don't close singleton

  if (!stats) {
    console.log(`${c.red}Session not found: ${name}${c.reset}`);
    return;
  }

  const tokensColor = stats.estimatedTokens > 70000 ? c.red : stats.estimatedTokens > 50000 ? c.yellow : c.green;

  console.log(`${c.bold}Session: ${c.cyan}${name}${c.reset}\n`);
  console.log(`  Messages:         ${c.bold}${stats.messageCount}${c.reset}`);
  console.log(`  Content size:     ${c.bold}${(stats.totalBytes / 1024).toFixed(1)} KB${c.reset}`);
  console.log(`  Estimated tokens: ${tokensColor}${c.bold}${stats.estimatedTokens.toLocaleString()}${c.reset}`);
  console.log(`\n  ${c.dim}Token limits: warning=50,000 | critical=70,000 | max=102,400${c.reset}`);

  if (stats.estimatedTokens > 50000) {
    console.log(`\n  ${c.yellow}⚠ Consider running: clawd --session-compact ${name}${c.reset}`);
  }
}

function compactSession(name: string) {
  const manager = getSessionManager();
  const statsBefore = manager.getSessionStatsByName(name);

  if (!statsBefore) {
    console.log(`${c.red}Session not found: ${name}${c.reset}`);
    return;
  }

  console.log(`${c.bold}Compacting session: ${c.cyan}${name}${c.reset}`);
  console.log(
    `  Before: ${statsBefore.messageCount} messages, ~${statsBefore.estimatedTokens.toLocaleString()} tokens`,
  );

  const summary = `[Session compacted: ${statsBefore.messageCount} messages (~${statsBefore.estimatedTokens} tokens) reduced to preserve context limits]`;
  const deleted = manager.compactSessionByName(name, 30, summary);

  const statsAfter = manager.getSessionStatsByName(name);
  // Don't close singleton

  if (deleted > 0) {
    console.log(`  ${c.green}✓ Deleted ${deleted} messages${c.reset}`);
    if (statsAfter) {
      console.log(
        `  After:  ${statsAfter.messageCount} messages, ~${statsAfter.estimatedTokens.toLocaleString()} tokens`,
      );
    }
  } else {
    console.log(`  ${c.dim}No compaction needed${c.reset}`);
  }
}

function resetSession(name: string) {
  const manager = getSessionManager();
  const stats = manager.getSessionStatsByName(name);

  if (!stats) {
    console.log(`${c.red}Session not found: ${name}${c.reset}`);
    return;
  }

  console.log(`${c.bold}Resetting session: ${c.cyan}${name}${c.reset}`);
  console.log(`  Deleting ${stats.messageCount} messages (~${stats.estimatedTokens.toLocaleString()} tokens)...`);

  manager.resetSession(name);
  // Don't close singleton

  console.log(`  ${c.green}✓ Session reset${c.reset}`);
}

// ============================================================================
// Proxy Server Config
// ============================================================================

interface ServeConfig {
  port: number;
  apiKey?: string;
  idleTimeout?: number; // Seconds before closing idle connections (default: 10)
  requestTimeout?: number; // Per-request timeout in seconds (default: 300 for LLM streaming)
}

function loadServeConfig(configPath?: string): ServeConfig {
  const defaultConfig: ServeConfig = {
    port: 3456,
    idleTimeout: 10,
    requestTimeout: 300,
  };
  const filePath = configPath || join(homedir(), ".clawd", "config.json");

  if (!existsSync(filePath)) {
    return defaultConfig;
  }

  try {
    const content = readFileSync(filePath, "utf-8");
    const config = JSON.parse(content);

    if (config.serve) {
      return {
        port: config.serve.port ?? defaultConfig.port,
        apiKey: config.serve.apiKey,
        idleTimeout: config.serve.idleTimeout ?? defaultConfig.idleTimeout,
        requestTimeout: config.serve.requestTimeout ?? defaultConfig.requestTimeout,
      };
    }
    return defaultConfig;
  } catch (err: any) {
    console.error(`${c.yellow}Warning: Failed to load config from ${filePath}: ${err.message}${c.reset}`);
    return defaultConfig;
  }
}

// ============================================================================
// Proxy Server (serve subcommand)
// ============================================================================

// Debug mode for serve command (set at runtime via --debug flag)
let SERVE_DEBUG = false;

function isDebugEnabled(): boolean {
  return SERVE_DEBUG;
}

function debugLog(category: string, ...args: any[]) {
  if (isDebugEnabled()) {
    const timestamp = new Date().toISOString();
    console.error(`[${timestamp}] [${category}]`, ...args);
  }
}

function debugLogJson(category: string, label: string, obj: any) {
  if (isDebugEnabled()) {
    const timestamp = new Date().toISOString();
    console.error(`[${timestamp}] [${category}] ${label}:`);
    console.error(JSON.stringify(obj, null, 2));
  }
}

const PROXY_CONFIG = {
  API_URL: API_URL,
  API_PATH: API_PATH,
  HEADERS: {
    "Content-Type": "application/json",
    Accept: "application/json",
    "X-Interaction-Type": "conversation-agent",
    "Openai-Intent": "conversation-agent",
    "X-Initiator": "agent",
    "X-GitHub-Api-Version": "2025-05-01",
    "Copilot-Integration-Id": "copilot-developer-cli",
    "User-Agent": "Claw'd/1.0.0",
  },
};

interface AnthropicMessage {
  role: "user" | "assistant";
  content: string | Array<{ type: string; text?: string; [key: string]: any }>;
}

interface AnthropicTool {
  name: string;
  description?: string;
  input_schema: any;
}

interface AnthropicRequest {
  model: string;
  messages: AnthropicMessage[];
  system?: string | Array<{ type: string; text: string }>;
  max_tokens: number;
  stream?: boolean;
  temperature?: number;
  top_p?: number;
  stop_sequences?: string[];
  metadata?: { user_id?: string };
  tools?: AnthropicTool[];
  tool_choice?: any;
}

interface OpenAIMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: Array<{
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }>;
  tool_call_id?: string;
}

interface OpenAITool {
  type: "function";
  function: {
    name: string;
    description?: string;
    parameters: any;
  };
}

interface OpenAIRequest {
  model: string;
  messages: OpenAIMessage[];
  stream?: boolean;
  temperature?: number;
  top_p?: number;
  max_completion_tokens?: number;
  stop?: string[];
  tools?: OpenAITool[];
  tool_choice?: any;
}

function anthropicToOpenAI(req: AnthropicRequest): OpenAIRequest {
  const messages: OpenAIMessage[] = [];

  if (req.system) {
    const systemContent = typeof req.system === "string" ? req.system : req.system.map((b) => b.text).join("\n");
    messages.push({ role: "system", content: systemContent });
  }

  for (const msg of req.messages) {
    if (typeof msg.content === "string") {
      messages.push({ role: msg.role, content: msg.content });
    } else if (Array.isArray(msg.content)) {
      // Handle complex content blocks (text, tool_use, tool_result)
      const textParts: string[] = [];
      const toolCalls: Array<{
        id: string;
        type: "function";
        function: { name: string; arguments: string };
      }> = [];
      const toolResults: Array<{ tool_call_id: string; content: string }> = [];

      for (const block of msg.content) {
        if (block.type === "text" && block.text) {
          textParts.push(block.text);
        } else if (block.type === "tool_use") {
          // Assistant message with tool call
          toolCalls.push({
            id: block.id,
            type: "function",
            function: {
              name: block.name,
              arguments: JSON.stringify(block.input || {}),
            },
          });
        } else if (block.type === "tool_result") {
          // User message with tool result
          const resultContent =
            typeof block.content === "string"
              ? block.content
              : Array.isArray(block.content)
                ? block.content
                    .filter((c: any) => c.type === "text")
                    .map((c: any) => c.text)
                    .join("\n")
                : "";
          toolResults.push({
            tool_call_id: block.tool_use_id,
            content: resultContent,
          });
        }
      }

      // Add assistant message with tool calls
      if (msg.role === "assistant") {
        if (toolCalls.length > 0) {
          messages.push({
            role: "assistant",
            content: textParts.length > 0 ? textParts.join("\n") : null,
            tool_calls: toolCalls,
          });
        } else {
          messages.push({ role: "assistant", content: textParts.join("\n") });
        }
      } else if (msg.role === "user") {
        // Handle tool results as separate tool role messages
        for (const result of toolResults) {
          messages.push({
            role: "tool",
            content: result.content,
            tool_call_id: result.tool_call_id,
          });
        }
        // Add any text content as user message
        if (textParts.length > 0) {
          messages.push({ role: "user", content: textParts.join("\n") });
        }
      }
    }
  }

  // Convert tools
  let tools: OpenAITool[] | undefined;
  if (req.tools && req.tools.length > 0) {
    tools = req.tools.map((tool) => ({
      type: "function" as const,
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.input_schema,
      },
    }));
  }

  // Convert tool_choice
  let toolChoice: any;
  if (req.tool_choice) {
    if (req.tool_choice.type === "auto") {
      toolChoice = "auto";
    } else if (req.tool_choice.type === "any") {
      toolChoice = "required";
    } else if (req.tool_choice.type === "tool" && req.tool_choice.name) {
      toolChoice = {
        type: "function",
        function: { name: req.tool_choice.name },
      };
    }
  }

  return {
    model: req.model,
    messages,
    stream: req.stream,
    temperature: req.temperature,
    top_p: req.top_p,
    max_completion_tokens: req.max_tokens,
    stop: req.stop_sequences,
    tools,
    tool_choice: toolChoice,
  };
}

function openAIToAnthropicResponse(openaiResponse: any, model: string): any {
  const choice = openaiResponse.choices?.[0];
  const message = choice?.message;

  // Build content array
  const content: any[] = [];

  // Add text content if present
  if (message?.content) {
    content.push({ type: "text", text: message.content });
  }

  // Add tool_use blocks if present
  if (message?.tool_calls && Array.isArray(message.tool_calls)) {
    for (const toolCall of message.tool_calls) {
      content.push({
        type: "tool_use",
        id: toolCall.id || `toolu_${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`,
        name: toolCall.function?.name || "",
        input: toolCall.function?.arguments ? JSON.parse(toolCall.function.arguments) : {},
      });
    }
  }

  // Determine stop reason
  let stopReason = "end_turn";
  if (message?.tool_calls && message.tool_calls.length > 0) {
    stopReason = "tool_use";
  } else if (choice?.finish_reason === "stop") {
    stopReason = "end_turn";
  } else if (choice?.finish_reason) {
    stopReason = choice.finish_reason;
  }

  return {
    id: openaiResponse.id || `msg_${crypto.randomUUID().replace(/-/g, "")}`,
    type: "message",
    role: "assistant",
    content: content.length > 0 ? content : [{ type: "text", text: "" }],
    model,
    stop_reason: stopReason,
    stop_sequence: null,
    usage: {
      input_tokens: openaiResponse.usage?.prompt_tokens || 0,
      output_tokens: openaiResponse.usage?.completion_tokens || 0,
    },
  };
}

// Create a streaming ReadableStream that manually reads from upstream and forwards chunks
function createStreamingResponse(
  upstreamBody: ReadableStream<Uint8Array>,
  transform?: (chunk: Uint8Array) => Uint8Array | null,
): ReadableStream<Uint8Array> {
  const reader = upstreamBody.getReader();
  const decoder = new TextDecoder();
  let chunkCount = 0;

  return new ReadableStream({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        chunkCount++;
        if (done) {
          debugLog("STREAM", `OpenAI stream done after ${chunkCount} chunks`);
          controller.close();
          return;
        }
        if (value) {
          debugLog("STREAM", `OpenAI chunk ${chunkCount}: ${decoder.decode(value).slice(0, 200)}`);
          if (transform) {
            const transformed = transform(value);
            if (transformed) {
              controller.enqueue(transformed);
            }
          } else {
            controller.enqueue(value);
          }
        }
      } catch (err) {
        controller.error(err);
      }
    },
    cancel() {
      reader.cancel();
    },
  });
}

// Track tool call state for streaming
interface ToolCallState {
  index: number; // OpenAI tool call index
  contentIndex: number; // Anthropic content block index
  id: string;
  name: string;
  started: boolean; // Whether we've emitted content_block_start
}

// Anthropic stream transformer - converts OpenAI SSE to Anthropic SSE format
function createAnthropicStreamingResponse(
  upstreamBody: ReadableStream<Uint8Array>,
  model: string,
  messageId: string,
): ReadableStream<Uint8Array> {
  const reader = upstreamBody.getReader();
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

  let outputTokens = 0;
  let sentStart = false;
  let buffer = "";
  let textBlockStarted = false;
  let currentContentIndex = 0;
  const toolCalls: Map<number, ToolCallState> = new Map();
  let stopReason: string | null = null;
  let chunkCount = 0;

  return new ReadableStream({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        chunkCount++;

        if (done) {
          debugLog("STREAM", `Anthropic stream done after ${chunkCount} chunks`);
          // Close any open text block
          if (textBlockStarted) {
            controller.enqueue(
              encoder.encode(
                `event: content_block_stop\ndata: ${JSON.stringify({
                  type: "content_block_stop",
                  index: 0,
                })}\n\n`,
              ),
            );
          }

          // Close any open tool blocks
          for (const [, toolState] of toolCalls) {
            if (toolState.started) {
              controller.enqueue(
                encoder.encode(
                  `event: content_block_stop\ndata: ${JSON.stringify({
                    type: "content_block_stop",
                    index: toolState.contentIndex,
                  })}\n\n`,
                ),
              );
            }
          }

          // Send final events if we started
          if (sentStart) {
            const finalStopReason = toolCalls.size > 0 ? "tool_use" : stopReason || "end_turn";
            controller.enqueue(
              encoder.encode(
                `event: message_delta\ndata: ${JSON.stringify({
                  type: "message_delta",
                  delta: { stop_reason: finalStopReason, stop_sequence: null },
                  usage: { output_tokens: outputTokens },
                })}\n\n`,
              ),
            );
            controller.enqueue(encoder.encode(`event: message_stop\ndata: {"type":"message_stop"}\n\n`));
          }
          controller.close();
          return;
        }

        // Append to buffer and process complete lines
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || ""; // Keep incomplete line in buffer

        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          const data = line.slice(6).trim();
          if (data === "[DONE]") {
            debugLog("STREAM", "Received [DONE] signal");
            continue; // We handle close in done above
          }

          try {
            const parsed = JSON.parse(data);
            debugLog(
              "STREAM",
              `Chunk ${chunkCount}: ${JSON.stringify(parsed.choices?.[0]?.delta || {}).slice(0, 200)}`,
            );

            if (!sentStart) {
              sentStart = true;
              const inputTokens = parsed.usage?.prompt_tokens || 0;
              controller.enqueue(
                encoder.encode(
                  `event: message_start\ndata: ${JSON.stringify({
                    type: "message_start",
                    message: {
                      id: messageId,
                      type: "message",
                      role: "assistant",
                      content: [],
                      model,
                      stop_reason: null,
                      stop_sequence: null,
                      usage: { input_tokens: inputTokens, output_tokens: 0 },
                    },
                  })}\n\n`,
                ),
              );
            }

            const delta = parsed.choices?.[0]?.delta;

            // Handle text content
            if (delta?.content) {
              // Start text block if not started
              if (!textBlockStarted) {
                textBlockStarted = true;
                controller.enqueue(
                  encoder.encode(
                    `event: content_block_start\ndata: ${JSON.stringify({
                      type: "content_block_start",
                      index: currentContentIndex,
                      content_block: { type: "text", text: "" },
                    })}\n\n`,
                  ),
                );
                currentContentIndex++;
              }

              outputTokens += 1;
              controller.enqueue(
                encoder.encode(
                  `event: content_block_delta\ndata: ${JSON.stringify({
                    type: "content_block_delta",
                    index: 0,
                    delta: { type: "text_delta", text: delta.content },
                  })}\n\n`,
                ),
              );
            }

            // Handle tool calls
            if (delta?.tool_calls) {
              // Close text block if open (tool calls come after text)
              if (textBlockStarted) {
                controller.enqueue(
                  encoder.encode(
                    `event: content_block_stop\ndata: ${JSON.stringify({
                      type: "content_block_stop",
                      index: 0,
                    })}\n\n`,
                  ),
                );
                textBlockStarted = false;
              }

              for (const toolCall of delta.tool_calls) {
                const toolIndex = toolCall.index;

                // Get or create tool call state
                let toolState = toolCalls.get(toolIndex);
                if (!toolState) {
                  toolState = {
                    index: toolIndex,
                    contentIndex: currentContentIndex,
                    id: toolCall.id || `toolu_${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`,
                    name: toolCall.function?.name || "",
                    started: false,
                  };
                  toolCalls.set(toolIndex, toolState);
                  currentContentIndex++;
                }

                // Update name if provided (first chunk usually has name)
                if (toolCall.function?.name) {
                  toolState.name = toolCall.function.name;
                }

                // Update id if provided
                if (toolCall.id) {
                  toolState.id = toolCall.id;
                }

                // Start tool block if we have name and haven't started
                if (toolState.name && !toolState.started) {
                  toolState.started = true;
                  controller.enqueue(
                    encoder.encode(
                      `event: content_block_start\ndata: ${JSON.stringify({
                        type: "content_block_start",
                        index: toolState.contentIndex,
                        content_block: {
                          type: "tool_use",
                          id: toolState.id,
                          name: toolState.name,
                          input: {},
                        },
                      })}\n\n`,
                    ),
                  );
                }

                // Stream arguments as input_json_delta
                if (toolCall.function?.arguments && toolState.started) {
                  outputTokens += 1;
                  controller.enqueue(
                    encoder.encode(
                      `event: content_block_delta\ndata: ${JSON.stringify({
                        type: "content_block_delta",
                        index: toolState.contentIndex,
                        delta: {
                          type: "input_json_delta",
                          partial_json: toolCall.function.arguments,
                        },
                      })}\n\n`,
                    ),
                  );
                }
              }
            }

            // Track finish reason
            if (parsed.choices?.[0]?.finish_reason) {
              stopReason = parsed.choices[0].finish_reason === "tool_calls" ? "tool_use" : "end_turn";
            }
          } catch {
            // Skip invalid JSON
          }
        }
      } catch (err) {
        controller.error(err);
      }
    },
    cancel() {
      reader.cancel();
    },
  });
}

async function handleProxyRequest(req: Request, token: string): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname;

  debugLog("REQUEST", `${req.method} ${path}`);

  // Health check endpoint
  if (path === "/health" || path === "/") {
    return new Response(JSON.stringify({ status: "ok", service: "clawd-proxy" }), {
      headers: { "Content-Type": "application/json" },
    });
  }

  // Models endpoint
  if (path === "/v1/models" || path === "/models") {
    return new Response(
      JSON.stringify({
        object: "list",
        data: [
          { id: "claude-sonnet-4", object: "model", owned_by: "anthropic" },
          { id: "claude-opus-4", object: "model", owned_by: "anthropic" },
          { id: "gpt-4.1", object: "model", owned_by: "openai" },
          { id: "gpt-4o", object: "model", owned_by: "openai" },
          { id: "o3-mini", object: "model", owned_by: "openai" },
          { id: "gemini-2.0-flash-001", object: "model", owned_by: "google" },
        ],
      }),
      { headers: { "Content-Type": "application/json" } },
    );
  }

  // Anthropic Messages API endpoint
  if (path === "/v1/messages" || path === "/messages") {
    if (req.method !== "POST") {
      return new Response(
        JSON.stringify({
          type: "error",
          error: {
            type: "invalid_request_error",
            message: "Method not allowed",
          },
        }),
        { status: 405, headers: { "Content-Type": "application/json" } },
      );
    }

    try {
      const body = await req.text();
      const anthropicReq: AnthropicRequest = JSON.parse(body);
      const isStreaming = anthropicReq.stream === true;
      const model = anthropicReq.model;
      const messageId = `msg_${crypto.randomUUID().replace(/-/g, "")}`;

      debugLog("ANTHROPIC", `model=${model} stream=${isStreaming} messages=${anthropicReq.messages.length}`);
      debugLogJson("ANTHROPIC", "Request (Anthropic format)", {
        model: anthropicReq.model,
        stream: anthropicReq.stream,
        max_tokens: anthropicReq.max_tokens,
        system: anthropicReq.system
          ? typeof anthropicReq.system === "string"
            ? anthropicReq.system.slice(0, 100) + "..."
            : "[array]"
          : undefined,
        messages: anthropicReq.messages.map((m) => ({
          role: m.role,
          content:
            typeof m.content === "string"
              ? m.content.slice(0, 100) + (m.content.length > 100 ? "..." : "")
              : `[${(m.content as any[]).length} blocks]`,
        })),
        tools: anthropicReq.tools?.length ? `${anthropicReq.tools.length} tools` : undefined,
      });

      const openaiReq = anthropicToOpenAI(anthropicReq);

      debugLogJson("ANTHROPIC", "Converted to OpenAI format", {
        model: openaiReq.model,
        stream: openaiReq.stream,
        messages: openaiReq.messages.map((m) => ({
          role: m.role,
          content: m.content
            ? typeof m.content === "string"
              ? m.content.slice(0, 100) + (m.content.length > 100 ? "..." : "")
              : m.content
            : null,
          tool_calls: m.tool_calls ? `${m.tool_calls.length} calls` : undefined,
          tool_call_id: m.tool_call_id,
        })),
        tools: openaiReq.tools?.length ? `${openaiReq.tools.length} functions` : undefined,
      });

      const upstreamResponse = await fetch(`${PROXY_CONFIG.API_URL}${PROXY_CONFIG.API_PATH}`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "X-Interaction-Id": crypto.randomUUID(),
          ...PROXY_CONFIG.HEADERS,
        },
        body: JSON.stringify(openaiReq),
      });

      debugLog("ANTHROPIC", `Upstream response: ${upstreamResponse.status} ${upstreamResponse.statusText}`);

      if (!upstreamResponse.ok) {
        const errorText = await upstreamResponse.text();
        debugLog("ANTHROPIC", `Upstream error: ${errorText}`);
        return new Response(
          JSON.stringify({
            type: "error",
            error: { type: "api_error", message: errorText },
          }),
          {
            status: upstreamResponse.status,
            headers: { "Content-Type": "application/json" },
          },
        );
      }

      if (isStreaming) {
        debugLog("ANTHROPIC", "Starting streaming response...");
        // Use manual streaming to ensure chunks are forwarded immediately
        const streamingBody = createAnthropicStreamingResponse(upstreamResponse.body!, model, messageId);
        return new Response(streamingBody, {
          headers: {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            Connection: "keep-alive",
            "Access-Control-Allow-Origin": "*",
          },
        });
      } else {
        const openaiResponse = await upstreamResponse.json();
        const anthropicResponse = openAIToAnthropicResponse(openaiResponse, model);
        return new Response(JSON.stringify(anthropicResponse), {
          headers: {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*",
          },
        });
      }
    } catch (error: any) {
      return new Response(
        JSON.stringify({
          type: "error",
          error: { type: "api_error", message: error.message },
        }),
        {
          status: 500,
          headers: { "Content-Type": "application/json" },
        },
      );
    }
  }

  // Chat completions - OpenAI format
  if (path === PROXY_CONFIG.API_PATH) {
    if (req.method !== "POST") {
      return new Response(JSON.stringify({ error: "Method not allowed" }), {
        status: 405,
        headers: { "Content-Type": "application/json" },
      });
    }

    try {
      const body = await req.text();
      const requestBody = JSON.parse(body);
      const isStreaming = requestBody.stream === true;

      debugLog("OPENAI", `model=${requestBody.model} stream=${isStreaming} messages=${requestBody.messages?.length}`);
      debugLogJson("OPENAI", "Request", {
        model: requestBody.model,
        stream: requestBody.stream,
        messages: requestBody.messages?.map((m: any) => ({
          role: m.role,
          content: m.content
            ? typeof m.content === "string"
              ? m.content.slice(0, 100) + (m.content.length > 100 ? "..." : "")
              : m.content
            : null,
          tool_calls: m.tool_calls ? `${m.tool_calls.length} calls` : undefined,
        })),
        tools: requestBody.tools?.length ? `${requestBody.tools.length} functions` : undefined,
      });

      const upstreamResponse = await fetch(`${PROXY_CONFIG.API_URL}${PROXY_CONFIG.API_PATH}`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "X-Interaction-Id": crypto.randomUUID(),
          ...PROXY_CONFIG.HEADERS,
        },
        body,
      });

      debugLog("OPENAI", `Upstream response: ${upstreamResponse.status} ${upstreamResponse.statusText}`);

      if (!upstreamResponse.ok) {
        const errorText = await upstreamResponse.text();
        debugLog("OPENAI", `Upstream error: ${errorText}`);
        return new Response(errorText, {
          status: upstreamResponse.status,
          headers: { "Content-Type": "application/json" },
        });
      }

      if (isStreaming) {
        debugLog("OPENAI", "Starting streaming response...");
        // Use manual streaming to ensure chunks are forwarded immediately
        const streamingBody = createStreamingResponse(upstreamResponse.body!);
        return new Response(streamingBody, {
          headers: {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            Connection: "keep-alive",
            "Access-Control-Allow-Origin": "*",
          },
        });
      } else {
        const responseBody = await upstreamResponse.text();
        return new Response(responseBody, {
          headers: {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*",
          },
        });
      }
    } catch (error: any) {
      return new Response(JSON.stringify({ error: error.message }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      });
    }
  }

  // CORS preflight
  if (req.method === "OPTIONS") {
    return new Response(null, {
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization, x-api-key, anthropic-version",
      },
    });
  }

  return new Response(JSON.stringify({ error: "Not found" }), {
    status: 404,
    headers: { "Content-Type": "application/json" },
  });
}

function showServeHelp() {
  console.log(`
${c.bold}${c.cyan}Claw'd${c.reset} serve - Copilot API Proxy Server

${c.bold}Usage:${c.reset}
  clawd serve              Start server on port 3456
  clawd serve --port 8080  Start server on custom port

${c.bold}Options:${c.reset}
  --port, -p <port>        Port to listen on (default: 3456)
  --config, -c <path>      Config file path (default: ~/.clawd/config.json)
  --debug, -d              Enable debug logging (show requests/responses)
  --idle-timeout <sec>     Idle connection timeout in seconds (default: 10)
  --request-timeout <sec>  Per-request timeout for LLM calls in seconds (default: 300)
  -h, --help               Show this help

${c.bold}Config File:${c.reset}
  The config file (~/.clawd/config.json) can contain:
  {
    "serve": {
      "port": 3456,           // Default port
      "apiKey": "your-key",   // Optional: require API key auth
      "idleTimeout": 10,      // Idle connection timeout (seconds)
      "requestTimeout": 300   // Per-request timeout for LLM calls (seconds)
    }
  }

  When apiKey is set, all requests must include:
    Authorization: Bearer <apiKey>

${c.bold}Endpoints:${c.reset}
  GET  /health              Health check
  GET  /v1/models           List available models
  POST /v1/chat/completions Chat completions (OpenAI format)
  POST /v1/messages         Messages API (Anthropic format)

${c.bold}Examples:${c.reset}
  # OpenAI format
  curl http://localhost:3456/v1/chat/completions \\
    -H "Content-Type: application/json" \\
    -d '{"model":"claude-sonnet-4","messages":[{"role":"user","content":"Hello"}]}'

  # Anthropic format
  curl http://localhost:3456/v1/messages \\
    -H "Content-Type: application/json" \\
    -d '{"model":"claude-sonnet-4","max_tokens":1024,"messages":[{"role":"user","content":"Hello"}]}'

  # With API key authentication
  curl http://localhost:3456/v1/chat/completions \\
    -H "Content-Type: application/json" \\
    -H "Authorization: Bearer your-api-key" \\
    -d '{"model":"claude-sonnet-4","messages":[{"role":"user","content":"Hello"}]}'
`);
}

interface StartProxyServerOptions {
  port?: number;
  configPath?: string;
  debug?: boolean;
  idleTimeout?: number;
  requestTimeout?: number;
}

async function startProxyServer(options: StartProxyServerOptions = {}) {
  // Set debug mode
  SERVE_DEBUG = options.debug ?? false;

  // Load config
  const config = loadServeConfig(options.configPath);
  const port = options.port ?? config.port;
  const apiKey = config.apiKey;
  const idleTimeout = options.idleTimeout ?? config.idleTimeout ?? 10;
  const requestTimeout = options.requestTimeout ?? config.requestTimeout ?? 300;

  const token = getToken();
  if (!token) {
    console.error(`${c.red}Error: No GitHub token found${c.reset}`);
    console.error(`Run: gh auth login && gh auth refresh -s copilot`);
    process.exit(1);
  }

  console.log(`${c.bold}${c.cyan}Claw'd${c.reset} - Copilot API Proxy`);
  console.log(`Listening on http://localhost:${port}`);
  console.log(`Debug mode: ${SERVE_DEBUG ? `${c.green}enabled${c.reset}` : `${c.dim}disabled${c.reset}`}`);
  console.log(`Idle timeout: ${idleTimeout}s | Request timeout: ${requestTimeout}s`);
  if (apiKey) {
    console.log(`${c.green}API key authentication enabled${c.reset}`);
  }
  console.log(`\n${c.bold}Endpoints:${c.reset}`);
  console.log(`  GET  /health              - Health check`);
  console.log(`  GET  /v1/models           - List models`);
  console.log(`  POST /v1/chat/completions - Chat completions (OpenAI format)`);
  console.log(`  POST /v1/messages         - Messages API (Anthropic format)`);
  console.log(`\nPress Ctrl+C to stop\n`);

  Bun.serve({
    port,
    idleTimeout,
    fetch: (req, server) => {
      // Set per-request timeout for LLM requests (they can take a while)
      const url = new URL(req.url);
      if (url.pathname.includes("/messages") || url.pathname.includes("/chat/completions")) {
        server.timeout(req, requestTimeout);
      }

      // API key authentication
      if (apiKey) {
        // Skip auth for health check
        if (url.pathname !== "/health" && url.pathname !== "/") {
          const authHeader = req.headers.get("Authorization");
          const providedKey = authHeader?.replace(/^Bearer\s+/i, "");

          if (!providedKey || providedKey !== apiKey) {
            return new Response(
              JSON.stringify({
                error: {
                  message: "Invalid or missing API key",
                  type: "authentication_error",
                },
              }),
              { status: 401, headers: { "Content-Type": "application/json" } },
            );
          }
        }
      }

      return handleProxyRequest(req, token);
    },
  });
}

// ============================================================================
// Interactive Chat
// ============================================================================

async function interactiveChat(agent: Agent, sessionName: string, model: string) {
  const readline = await import("node:readline");

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  // When readline closes (Ctrl+C, Ctrl+D, etc.), exit cleanly
  rl.on("close", () => {
    process.stdout.write(`${c.reset}\n`);
    try {
      agent.cancel();
    } catch {}
    try {
      agent.close();
    } catch {}
    process.exit(0);
  });

  console.log(`${c.bold}${c.cyan}Claw'd${c.reset} - Interactive Mode`);
  console.log(
    `${c.dim}Session: ${sessionName}  |  Model: ${model}  |  Type 'exit' to quit  |  Press Esc to interrupt${c.reset}\n`,
  );

  const prompt = () => {
    rl.question(`${c.green}> ${c.reset}`, async (input) => {
      const trimmed = input.trim();

      if (!trimmed) {
        prompt();
        return;
      }

      if (trimmed === "exit" || trimmed === "quit") {
        rl.close();
        try {
          agent.close();
        } catch {}
        return;
      }

      // Listen for Escape key during agent execution to interrupt
      const onKeypress = (_ch: string, key: any) => {
        if (key && key.name === "escape") {
          process.stdout.write(`\n${c.yellow}⏹ Interrupted${c.reset}\n`);
          agent.cancel();
        }
      };
      process.stdin.on("keypress", onKeypress);

      try {
        process.stdout.write(`${c.cyan}`);
        const result = await agent.run(trimmed, sessionName);
        process.stdout.write(`${c.reset}\n\n`);

        if (result.toolCalls.length > 0) {
          console.log(`${c.dim}[${result.toolCalls.length} tool calls, ${result.iterations} iterations]${c.reset}\n`);
        }
      } catch {
        // Silently swallow all errors (abort, stream, etc.) — return to prompt
        process.stdout.write(`${c.reset}\n`);
      } finally {
        process.stdin.removeListener("keypress", onKeypress);
      }

      prompt();
    });
  };

  prompt();
}

// ============================================================================
// report_agent_result Tool (conditional - only when --result-file is set)
// ============================================================================

function registerReportResultTool(resultFilePath: string) {
  const handler = async (args: Record<string, any>) => {
    const content = args.content as string;
    const status = (args.status as string) || "success";
    const append = args.append === true;

    try {
      mkdirSync(dirname(resultFilePath), { recursive: true });

      if (append && existsSync(resultFilePath)) {
        // Read existing, append content
        const existing = JSON.parse(readFileSync(resultFilePath, "utf8"));
        existing.result = `${existing.result || ""}\n${content}`;
        existing.completedAt = Date.now();
        writeFileSync(resultFilePath, JSON.stringify(existing));
      } else {
        writeFileSync(
          resultFilePath,
          JSON.stringify({
            success: status === "success",
            result: content,
            completedAt: Date.now(),
          }),
        );
      }

      return {
        success: true,
        output: `Result written to file (${status}, ${content.length} chars)`,
      };
    } catch (err: any) {
      return {
        success: false,
        output: "",
        error: `Failed to write result: ${err.message}`,
      };
    }
  };

  tools.set("report_agent_result", handler);
  toolDefinitions.push({
    type: "function",
    function: {
      name: "report_agent_result",
      description:
        "Write your final result/report to the result file. The parent agent will read this. " +
        "Call this when you have completed your task and want to report back. " +
        "You can call it once with the full report, or multiple times with append=true to build up the result incrementally.",
      parameters: {
        type: "object",
        properties: {
          content: {
            type: "string",
            description: "The result content to report (markdown, JSON, plain text, etc.)",
          },
          status: {
            type: "string",
            enum: ["success", "error"],
            description: 'Status of the result. Default: "success"',
          },
          append: {
            type: "boolean",
            description: "If true, append to existing result instead of overwriting. Default: false",
          },
        },
        required: ["content"],
      },
    },
  } as ToolDefinition);
}

// ============================================================================
// Single Prompt Mode
// ============================================================================

async function runPrompt(agent: Agent, prompt: string, sessionName: string, out: OutputWriter, resultFile?: string) {
  try {
    out.write(`${c.cyan}`);

    const result = await agent.run(prompt, sessionName);

    out.write(`${c.reset}\n`);

    if (result.toolCalls.length > 0 && !process.argv.includes("-v")) {
      out.writeLine(`\n${c.dim}[${result.toolCalls.length} tool calls, ${result.iterations} iterations]${c.reset}`);
    }

    // Result file is written by the report_agent_result tool (if the agent called it).
    // We only auto-write on error (crash fallback below) since the agent can't
    // call tools if it crashes.

    await agent.close();

    // Force exit - async sub-agents (wait=false) may keep event loop alive
    // This ensures the process exits cleanly after the main task completes
    process.exit(0);
  } catch (err: any) {
    // Crash fallback: write failure result file if path is set.
    // The agent couldn't call report_agent_result, so we write a failure marker.
    if (resultFile) {
      try {
        mkdirSync(dirname(resultFile), { recursive: true });
        writeFileSync(
          resultFile,
          JSON.stringify({
            success: false,
            error: err.message,
            completedAt: Date.now(),
          }),
        );
      } catch {}
    }
    console.error(`${c.red}Error: ${err.message}${c.reset}`);
    process.exit(1);
  }
}

// ============================================================================
// Main
// ============================================================================

async function main() {
  const args = parseArgs();

  // Enable debug mode if --debug flag is set
  if (args.debug) {
    setDebug(true);
  }

  // Handle serve subcommand first
  if (args.serve) {
    if (args.help) {
      showServeHelp();
      return;
    }
    await startProxyServer({
      port: args.servePort,
      configPath: args.serveConfig,
      debug: args.serveDebug,
      idleTimeout: args.serveIdleTimeout,
      requestTimeout: args.serveRequestTimeout,
    });
    return;
  }

  // Initialize sandbox (enabled by default unless --yolo)
  await initSandbox(args.yolo);

  // Initialize project hash for data isolation
  if (args.projectHash) {
    setProjectHash(args.projectHash);
    console.error(`[Project] Hash: ${args.projectHash}`);
  }
  // If not set, auto-generated from SHA-256(cwd) on first access

  if (args.help) {
    showHelp();
    return;
  }

  if (args.list) {
    listSessions();
    return;
  }

  // Session management commands (no token needed)
  if (args.sessionStats) {
    showSessionStats(args.sessionStats);
    return;
  }

  if (args.sessionCompact) {
    compactSession(args.sessionCompact);
    return;
  }

  if (args.sessionReset) {
    resetSession(args.sessionReset);
    return;
  }

  // Load MCP configs (non-blocking, errors logged but don't fail)
  await loadMCPConfigs();

  // Load CLAWD.md context + agent identity
  const clawdContext = loadClawdContext(args.agentId);

  // Get token
  const token = getToken();
  if (!token) {
    console.error(`${c.red}Error: No GitHub token found${c.reset}`);
    console.error(`Run: gh auth login && gh auth refresh -s copilot`);
    process.exit(1);
  }

  // Validate token
  // if (!token.startsWith("gho_") && !token.startsWith("ghu_") && !token.startsWith("github_pat_")) {
  //   console.error(`${c.red}Error: Invalid token type${c.reset}`);
  //   console.error(`Need OAuth token (gho_*) or fine-grained PAT (github_pat_*)`);
  //   process.exit(1);
  // }

  // Track output state for newline management
  let inThinking = false;
  let hadOutput = false; // true if text or thinking was written (needs trailing \n before tool call)

  // Create output writer for file/tee support
  const out = new OutputWriter(args.output, args.tee);

  // Create agent config
  const config: AgentConfig = {
    model: args.model,
    verbose: args.verbose,
    maxIterations: args.maxIterations,
    tokenLimitWarning: args.tokenLimitWarning,
    tokenLimitCritical: args.tokenLimitCritical,
    additionalContext: clawdContext || undefined, // CLAWD.md context appended to system prompt
    onToken: (token) => {
      // If we were in thinking mode, close it and add newline
      if (inThinking) {
        out.write(`${c.reset}\n\n`);
        inThinking = false;
      }
      out.write(token);
      hadOutput = true;
    },
    onThinkingToken: (token) => {
      // Start thinking block if not already
      if (!inThinking) {
        out.write(`${hadOutput ? "\n" : ""}${c.dim}[Thinking] `);
        inThinking = true;
      }
      out.write(token);
      hadOutput = true;
    },
    onToolCall: (name, toolArgs) => {
      // Close thinking block if open
      if (inThinking) {
        out.write(`${c.reset}\n`);
        inThinking = false;
      } else if (hadOutput) {
        out.write("\n");
      }
      hadOutput = true; // Mark that we have output (the tool call line)
      // Format args as key="value" pairs
      const argParts = Object.entries(toolArgs).map(([k, v]) => {
        const val = typeof v === "string" ? v : JSON.stringify(v);
        const truncVal = val.length > 50 ? `${val.slice(0, 50)}...` : val;
        return `${k}="${truncVal}"`;
      });
      const argsStr = argParts.join(", ");
      // Print tool call on its own line WITH newline so it flushes immediately
      // (without newline, piped stdout buffers and tool call only shows after result)
      out.writeLine(`${c.yellow}${name}${c.reset}${c.dim}(${argsStr})${c.reset}`);
    },
    onToolResult: (_name, result) => {
      if (args.verbose) {
        const output = result.output.length > 200 ? `${result.output.slice(0, 200)}...` : result.output;
        out.writeLine(`  ${result.success ? `${c.green}ok${c.reset}` : `${c.red}err${c.reset}`}`);
        out.writeLine(`${c.dim}  ${output}${c.reset}`);
      } else {
        out.writeLine(
          `  ${result.success ? `${c.green}ok${c.reset}` : `${c.red}err: ${(result.error || "").slice(0, 80)}${c.reset}`}`,
        );
      }
    },
    onCompaction: (deleted, remaining) => {
      out.writeLine(`\n${c.yellow}[Compaction]${c.reset} Removed ${deleted} old messages, kept ${remaining}`);
    },
  };

  // Register report_agent_result tool if --result-file is set (sub-agent mode)
  if (args.resultFile) {
    registerReportResultTool(args.resultFile);
  }

  // Create agent
  const agent = new Agent(token, config);

  // Load plugin if specified
  if (args.plugin) {
    try {
      const pluginConfig = JSON.parse(args.plugin);
      const pluginType = pluginConfig.type;

      if (!pluginType) {
        throw new Error('Plugin config must have a "type" field');
      }

      // Load plugin from ~/.clawd/plugins/{type}/index.js
      const pluginDir = `${process.env.HOME}/.clawd/plugins/${pluginType}`;
      const pluginPath = `${pluginDir}/index.js`;

      // Check if plugin exists
      const pluginFile = Bun.file(pluginPath);
      if (!(await pluginFile.exists())) {
        throw new Error(
          `Plugin not found: ${pluginPath}\nRun 'bun run build:plugins' in clawd directory to build plugins.`,
        );
      }

      // Dynamic import of plugin module
      const pluginModule = await import(pluginPath);
      const pluginFactory = pluginModule.default;

      if (!pluginFactory || typeof pluginFactory.createPlugin !== "function") {
        throw new Error(`Plugin ${pluginType} does not export default.createPlugin()`);
      }

      // Create and register plugin
      const plugin = pluginFactory.createPlugin(pluginConfig);
      await agent.usePlugin(plugin);

      if (args.verbose) {
        console.log(
          `${c.dim}[Plugin] Loaded ${pluginType} plugin${pluginConfig.channel ? ` for channel: ${pluginConfig.channel}` : ""}${c.reset}`,
        );
      }
    } catch (err: any) {
      console.error(`${c.red}Failed to load plugin: ${err.message}${c.reset}`);
      process.exit(1);
    }
  }

  // Resume session if specified
  if (args.resume) {
    const session = agent.resumeSession(args.resume);
    if (!session) {
      console.error(`${c.red}Session not found: ${args.resume}${c.reset}`);
      process.exit(1);
    }
    args.session = session.name;
  }

  const sessionName = args.session || `session-${Date.now()}`;

  // Run in appropriate mode
  if (args.chat || args.resume) {
    // Resume implies chat mode if no prompt given
    await interactiveChat(agent, sessionName, args.model);
  } else if (args.prompt) {
    await runPrompt(agent, args.prompt, sessionName, out, args.resultFile);
  } else {
    showHelp();
  }
}

main().catch(console.error);
