/**
 * MCP (Model Context Protocol) Client
 * Connects to external MCP servers and proxies their tools
 */

import { spawn, type Subprocess } from "bun";
import { EventEmitter } from "node:events";
import { isDebugEnabled } from "../utils/debug";

// ============================================================================
// Types
// ============================================================================

export interface MCPServerConfig {
  name: string;
  command?: string; // For stdio transport
  args?: string[];
  env?: Record<string, string>;
  url?: string; // For HTTP transport
  transport?: "stdio" | "http";
}

export interface MCPTool {
  name: string;
  description: string;
  inputSchema: {
    type: "object";
    properties: Record<string, any>;
    required?: string[];
  };
}

export interface MCPResource {
  uri: string;
  name: string;
  description?: string;
  mimeType?: string;
}

export interface MCPPrompt {
  name: string;
  description?: string;
  arguments?: Array<{
    name: string;
    description?: string;
    required?: boolean;
  }>;
}

interface MCPRequest {
  jsonrpc: "2.0";
  id: number;
  method: string;
  params?: any;
}

interface MCPResponse {
  jsonrpc: "2.0";
  id: number;
  result?: any;
  error?: {
    code: number;
    message: string;
    data?: any;
  };
}

// ============================================================================
// MCP Connection Interface
// ============================================================================

interface IMCPConnection extends EventEmitter {
  readonly name: string;
  tools: MCPTool[];
  resources: MCPResource[];
  prompts: MCPPrompt[];
  connected: boolean;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  request(method: string, params?: any): Promise<any>;
  callTool(name: string, args: Record<string, any>): Promise<any>;
}

// ============================================================================
// MCP Stdio Connection
// ============================================================================

class MCPStdioConnection extends EventEmitter implements IMCPConnection {
  private process: Subprocess | null = null;
  private requestId = 0;
  private pendingRequests = new Map<number, { resolve: Function; reject: Function }>();
  private buffer = "";

  readonly name: string;
  private command: string;
  private args: string[];
  private env: Record<string, string>;

  tools: MCPTool[] = [];
  resources: MCPResource[] = [];
  prompts: MCPPrompt[] = [];

  connected = false;

  constructor(config: MCPServerConfig) {
    super();
    this.name = config.name;
    this.command = config.command;
    this.args = config.args || [];
    this.env = config.env || {};
  }

  // ============================================================================
  // Connect
  // ============================================================================

  async connect(): Promise<void> {
    this.process = spawn({
      cmd: [this.command, ...this.args],
      env: { ...process.env, ...this.env },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });

    // Read stdout
    this.readOutput();

    // Initialize connection
    await this.request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {
        tools: {},
        prompts: {},
        resources: {},
      },
      clientInfo: {
        name: "clawd",
        version: "1.0.0",
      },
    });

    // Send initialized notification
    this.notify("notifications/initialized", {});

    // Fetch capabilities
    await this.refreshCapabilities();

    this.connected = true;
    this.emit("connected");
  }

  // ============================================================================
  // Read Output
  // ============================================================================

  private async readOutput() {
    if (!this.process?.stdout) return;

    const reader = (this.process.stdout as ReadableStream<Uint8Array>).getReader();
    const decoder = new TextDecoder();

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        this.buffer += decoder.decode(value, { stream: true });
        this.processBuffer();
      }
    } catch (error) {
      this.emit("error", error);
    }
  }

  // ============================================================================
  // Process Buffer
  // ============================================================================

  private processBuffer() {
    const lines = this.buffer.split("\n");
    this.buffer = lines.pop() || "";

    for (const line of lines) {
      if (!line.trim()) continue;

      try {
        const message: MCPResponse = JSON.parse(line);

        if (message.id !== undefined) {
          const pending = this.pendingRequests.get(message.id);
          if (pending) {
            this.pendingRequests.delete(message.id);
            if (message.error) {
              pending.reject(new Error(message.error.message));
            } else {
              pending.resolve(message.result);
            }
          }
        } else {
          // Notification
          this.emit("notification", message);
        }
      } catch (_error) {
        console.error("Failed to parse MCP message:", line);
      }
    }
  }

  // ============================================================================
  // Request
  // ============================================================================

  async request(method: string, params?: any): Promise<any> {
    if (!this.process?.stdin) {
      throw new Error("MCP server not connected");
    }

    const id = ++this.requestId;
    const request: MCPRequest = {
      jsonrpc: "2.0",
      id,
      method,
      params,
    };

    return new Promise((resolve, reject) => {
      this.pendingRequests.set(id, { resolve, reject });

      const message = `${JSON.stringify(request)}\n`;
      (this.process!.stdin as any).write(message);

      // Timeout
      setTimeout(() => {
        if (this.pendingRequests.has(id)) {
          this.pendingRequests.delete(id);
          reject(new Error(`MCP request timed out: ${method}`));
        }
      }, 30000);
    });
  }

  // ============================================================================
  // Notify
  // ============================================================================

  notify(method: string, params?: any): void {
    if (!this.process?.stdin) return;

    const notification = {
      jsonrpc: "2.0",
      method,
      params,
    };

    const message = `${JSON.stringify(notification)}\n`;
    (this.process.stdin as any).write(message);
  }

  // ============================================================================
  // Refresh Capabilities
  // ============================================================================

  async refreshCapabilities(): Promise<void> {
    try {
      const toolsResult = await this.request("tools/list", {});
      this.tools = toolsResult.tools || [];
    } catch {
      this.tools = [];
    }

    try {
      const resourcesResult = await this.request("resources/list", {});
      this.resources = resourcesResult.resources || [];
    } catch {
      this.resources = [];
    }

    try {
      const promptsResult = await this.request("prompts/list", {});
      this.prompts = promptsResult.prompts || [];
    } catch {
      this.prompts = [];
    }
  }

  // ============================================================================
  // Call Tool
  // ============================================================================

  async callTool(name: string, arguments_: Record<string, any>): Promise<any> {
    const result = await this.request("tools/call", {
      name,
      arguments: arguments_,
    });

    return result.content;
  }

  // ============================================================================
  // Get Resource
  // ============================================================================

  async getResource(uri: string): Promise<any> {
    const result = await this.request("resources/read", { uri });
    return result.contents;
  }

  // ============================================================================
  // Get Prompt
  // ============================================================================

  async getPrompt(name: string, arguments_?: Record<string, string>): Promise<any> {
    const result = await this.request("prompts/get", {
      name,
      arguments: arguments_,
    });
    return result.messages;
  }

  // ============================================================================
  // Disconnect
  // ============================================================================

  async disconnect(): Promise<void> {
    if (this.process) {
      this.process.kill();
      this.process = null;
    }
    this.connected = false;
    this.emit("disconnected");
  }
}

// ============================================================================
// MCP HTTP Connection
// ============================================================================

class MCPHttpConnection extends EventEmitter implements IMCPConnection {
  readonly name: string;
  private url: string;
  private requestId = 0;

  tools: MCPTool[] = [];
  resources: MCPResource[] = [];
  prompts: MCPPrompt[] = [];

  connected = false;

  constructor(config: MCPServerConfig) {
    super();
    this.name = config.name;
    this.url = config.url || "";
  }

  async connect(): Promise<void> {
    if (isDebugEnabled()) {
      console.log(`[MCP] Connecting to HTTP server: ${this.url}`);
    }
    // For HTTP, we just fetch tools/list to verify connectivity
    try {
      await this.refreshCapabilities();
      this.connected = true;
      if (isDebugEnabled()) {
        console.log(`[MCP] ${this.name}: Connected successfully`);
      }
      this.emit("connected");
    } catch (err: any) {
      console.error(`[MCP] ${this.name}: Connection failed: ${err.message}`);
      this.emit("error", err);
      throw err;
    }
  }

  private async refreshCapabilities(): Promise<void> {
    // Fetch tools
    try {
      const result = await this.request("tools/list", {});
      this.tools = result.tools || [];
      if (isDebugEnabled()) {
        console.log(`[MCP] ${this.name}: Loaded ${this.tools.length} tools`);
      }
    } catch (err: any) {
      console.error(`[MCP] ${this.name}: Failed to fetch tools: ${err.message}`);
      this.tools = [];
    }

    // Fetch resources
    try {
      const result = await this.request("resources/list", {});
      this.resources = result.resources || [];
    } catch (err: any) {
      console.error(`[MCP] ${this.name}: Failed to fetch resources: ${err.message}`);
      this.resources = [];
    }

    // Fetch prompts
    try {
      const result = await this.request("prompts/list", {});
      this.prompts = result.prompts || [];
    } catch (err: any) {
      console.error(`[MCP] ${this.name}: Failed to fetch prompts: ${err.message}`);
      this.prompts = [];
    }
  }

  async request(method: string, params?: any): Promise<any> {
    const id = ++this.requestId;
    const request: MCPRequest = {
      jsonrpc: "2.0",
      id,
      method,
      params,
    };

    const response = await fetch(this.url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(request),
    });

    if (!response.ok) {
      throw new Error(`HTTP error: ${response.status}`);
    }

    const data = (await response.json()) as MCPResponse;

    if (data.error) {
      throw new Error(data.error.message);
    }

    return data.result;
  }

  async callTool(name: string, args: Record<string, any>): Promise<any> {
    const result = await this.request("tools/call", { name, arguments: args });
    return result.content;
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    this.emit("disconnected");
  }
}

// ============================================================================
// MCP Manager
// ============================================================================

export class MCPManager extends EventEmitter {
  private connections = new Map<string, IMCPConnection>();

  // ============================================================================
  // Add Server
  // ============================================================================

  async addServer(config: MCPServerConfig): Promise<void> {
    if (this.connections.has(config.name)) {
      throw new Error(`Server ${config.name} already exists`);
    }

    // Choose connection type based on transport or presence of url/command
    const isHttp = config.transport === "http" || (config.url && !config.command);
    const connection: IMCPConnection = isHttp ? new MCPHttpConnection(config) : new MCPStdioConnection(config);

    connection.on("error", (error) => this.emit("server:error", config.name, error));
    connection.on("connected", () => this.emit("server:connected", config.name));
    connection.on("disconnected", () => this.emit("server:disconnected", config.name));

    await connection.connect();
    this.connections.set(config.name, connection);
  }

  // ============================================================================
  // Remove Server
  // ============================================================================

  async removeServer(name: string): Promise<void> {
    const connection = this.connections.get(name);
    if (connection) {
      await connection.disconnect();
      this.connections.delete(name);
    }
  }

  // ============================================================================
  // List Servers
  // ============================================================================

  listServers(): string[] {
    return [...this.connections.keys()];
  }

  // ============================================================================
  // Get All Tools
  // ============================================================================

  getAllTools(): Array<{ server: string; tool: MCPTool }> {
    const tools: Array<{ server: string; tool: MCPTool }> = [];

    for (const [name, connection] of this.connections) {
      for (const tool of connection.tools) {
        tools.push({ server: name, tool });
      }
    }

    return tools;
  }

  // ============================================================================
  // Check if tool exists in any MCP server
  // ============================================================================

  hasTool(toolName: string): boolean {
    for (const [, connection] of this.connections) {
      const hasTool = connection.tools.some((t) => t.name === toolName);
      if (hasTool) {
        return true;
      }
    }
    return false;
  }

  // ============================================================================
  // Get Tool Definitions (OpenAI format)
  // ============================================================================

  getToolDefinitions() {
    const definitions: any[] = [];

    if (isDebugEnabled()) {
      console.log(`[MCP] Connections: ${[...this.connections.keys()].join(", ") || "none"}`);
    }
    for (const [serverName, connection] of this.connections) {
      if (isDebugEnabled()) {
        console.log(`[MCP] Server "${serverName}" tools: ${connection.tools.map((t) => t.name).join(", ") || "none"}`);
      }
      for (const tool of connection.tools) {
        // All tools are native (no prefix) for cleaner API calls
        const toolName = tool.name;

        definitions.push({
          type: "function",
          function: {
            name: toolName,
            description: `[MCP:${serverName}] ${tool.description}`,
            parameters: tool.inputSchema,
          },
        });
      }
    }

    return definitions;
  }

  // ============================================================================
  // Call Tool
  // ============================================================================

  async callTool(serverName: string, toolName: string, args: Record<string, any>): Promise<any> {
    const connection = this.connections.get(serverName);
    if (!connection) {
      throw new Error(`MCP server ${serverName} not found`);
    }

    return await connection.callTool(toolName, args);
  }

  // ============================================================================
  // Execute MCP Tool (from tool name)
  // ============================================================================

  async executeMCPTool(
    toolName: string,
    args: Record<string, any>,
  ): Promise<{ success: boolean; result?: any; error?: string }> {
    // Check if it's a prefixed name (mcp_servername_toolname)
    const match = toolName.match(/^mcp_([^_]+)_(.+)$/);
    let serverName: string;
    let actualToolName: string;

    if (match) {
      // Prefixed format (for non-chat MCP tools)
      serverName = match[1];
      actualToolName = match[2];
    } else if (toolName.startsWith("chat_")) {
      // Chat tools are native - find which server provides them
      serverName = this.findServerForTool(toolName);
      actualToolName = toolName;
      if (!serverName) {
        return { success: false, error: `Unknown tool: ${toolName}` };
      }
    } else {
      // Try to find by tool name
      serverName = this.findServerForTool(toolName);
      actualToolName = toolName;
      if (!serverName) {
        return { success: false, error: `Unknown tool: ${toolName}` };
      }
    }

    try {
      const result = await this.callTool(serverName, actualToolName, args);
      return { success: true, result };
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  }

  // Find which MCP server provides this tool
  private findServerForTool(toolName: string): string | null {
    for (const [serverName, connection] of this.connections) {
      const hasTool = connection.tools.some((t) => t.name === toolName);
      if (hasTool) {
        return serverName;
      }
    }
    return null;
  }

  // ============================================================================
  // Get All Resources
  // ============================================================================

  getAllResources(): Array<{ server: string; resource: MCPResource }> {
    const resources: Array<{ server: string; resource: MCPResource }> = [];

    for (const [name, connection] of this.connections) {
      for (const resource of connection.resources) {
        resources.push({ server: name, resource });
      }
    }

    return resources;
  }

  // ============================================================================
  // Disconnect All
  // ============================================================================

  async disconnectAll(): Promise<void> {
    for (const [_name, connection] of this.connections) {
      await connection.disconnect();
    }
    this.connections.clear();
  }
}
