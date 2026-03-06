/**
 * Remote Worker MCP Connection
 *
 * Implements IMCPConnection to wrap a remote worker (identified by tokenHash).
 * Tool names are prefixed as `remote:{workerName}:{toolName}` to avoid
 * collision with built-in tools.
 */

import { EventEmitter } from "events";
import type { IMCPConnection } from "./client";
import type { MCPTool, MCPResource, MCPPrompt } from "./client";
import { callRemoteWorkerTool } from "../../../server/remote-worker";

export class RemoteWorkerMCPConnection extends EventEmitter implements IMCPConnection {
  readonly name: string;
  tools: MCPTool[] = [];
  resources: MCPResource[] = [];
  prompts: MCPPrompt[] = [];
  connected = false;

  private tokenHash: string;
  private workerName: string;

  constructor(
    tokenHash: string,
    workerName: string,
    registeredTools: Array<{ name: string; inputSchema: any; description: string }>,
  ) {
    super();
    this.tokenHash = tokenHash;
    this.workerName = workerName;
    this.name = `remote-worker-${workerName}`;

    this.tools = registeredTools.map((t) => ({
      name: `remote_${t.name}`,
      description: `[Remote: ${workerName}] ${t.description}`,
      inputSchema: t.inputSchema,
    }));
  }

  async connect(): Promise<void> {
    this.connected = true;
    this.emit("connected");
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    this.tools = [];
    this.emit("disconnected");
  }

  async request(method: string, params?: any): Promise<any> {
    if (method === "tools/call") return this.callTool(params.name, params.arguments);
    if (method === "tools/list") return { tools: this.tools };
    if (method === "resources/list") return { resources: [] };
    if (method === "prompts/list") return { prompts: [] };
    if (method === "initialize") return { capabilities: {} };
    throw new Error(`Unsupported method: ${method}`);
  }

  async callTool(prefixedName: string, args: Record<string, any>): Promise<any> {
    // Strip prefix: "remote_view" → "view"
    const toolName = prefixedName.startsWith("remote_") ? prefixedName.slice(7) : prefixedName;

    const result = await callRemoteWorkerTool(this.tokenHash, toolName, args);
    return [{ type: "text", text: typeof result === "string" ? result : JSON.stringify(result) }];
  }
}
