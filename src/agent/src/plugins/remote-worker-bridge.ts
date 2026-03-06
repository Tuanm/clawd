/**
 * Remote Worker Bridge
 *
 * Bridges server-side workerEvents → agent-side MCPManager.
 * NOT a ToolPlugin — tools flow through MCPManager.addConnection() path.
 * Listens for worker registration/disconnect events and manages MCP connections.
 */

import { workerEvents, getConnectedWorker, getTokenChannels } from "../../../server/remote-worker";
import { RemoteWorkerMCPConnection } from "../mcp/remote-worker-connection";
import { createHash } from "crypto";
import type { MCPManager } from "../mcp/client";

export class RemoteWorkerBridge {
  private mcpManager: MCPManager;
  private agentWorkerToken: string | undefined;
  private agentTokenHash: string | undefined;
  private channel: string;
  private destroyed = false;

  private onRegisteredHandler: (info: any) => void;
  private onDisconnectedHandler: (info: any) => void;

  constructor(mcpManager: MCPManager, channel: string, workerToken?: string) {
    this.mcpManager = mcpManager;
    this.channel = channel;
    this.agentWorkerToken = workerToken;
    this.agentTokenHash = workerToken ? createHash("sha256").update(workerToken).digest("hex") : undefined;

    this.onRegisteredHandler = (info) => this.onWorkerRegistered(info);
    this.onDisconnectedHandler = (info) => this.onWorkerDisconnected(info);

    workerEvents.on("worker:registered", this.onRegisteredHandler);
    workerEvents.on("worker:disconnected", this.onDisconnectedHandler);
  }

  /** Check for already-connected workers and register them. Must be awaited before agent.run(). */
  async init(): Promise<void> {
    if (this.agentTokenHash) {
      await this.checkExistingWorkers();
    }
  }

  private async checkExistingWorkers() {
    const worker = getConnectedWorker(this.agentTokenHash!);
    if (worker && worker.status === "connected" && worker.tools?.length) {
      await this.addWorkerConnection({
        tokenHash: this.agentTokenHash!,
        name: worker.name,
        projectRoot: worker.projectRoot,
        platform: worker.platform,
        tools: worker.tools,
        channels: getTokenChannels(worker.tokenHash),
      });
    }
  }

  private async addWorkerConnection(info: {
    tokenHash: string;
    name: string;
    projectRoot: string;
    platform: string;
    tools: Array<{ name: string; inputSchema: any; description: string }>;
    channels: string[] | "all";
  }) {
    if (this.destroyed) return;
    if (!this.agentTokenHash) return;
    if (info.tokenHash !== this.agentTokenHash) return;

    // Check channel authorization
    if (info.channels !== "all" && !info.channels.includes(this.channel)) return;

    const conn = new RemoteWorkerMCPConnection(info.tokenHash, info.name, info.tools);
    console.log(`[RemoteWorkerBridge] Adding ${conn.name} with ${info.tools.length} tools`);
    await this.mcpManager.addConnection(conn);
  }

  private onWorkerRegistered(info: {
    tokenHash: string;
    name: string;
    projectRoot: string;
    platform: string;
    tools: Array<{ name: string; inputSchema: any; description: string }>;
    channels: string[] | "all";
  }) {
    this.addWorkerConnection(info).catch(console.error);
  }

  private onWorkerDisconnected(info: { tokenHash: string; name: string }) {
    if (this.destroyed) return;
    if (info.tokenHash !== this.agentTokenHash) return;
    const connName = `remote-worker-${info.name}`;
    this.mcpManager.removeConnection(connName).catch(() => {});
  }

  destroy() {
    this.destroyed = true;
    workerEvents.off("worker:registered", this.onRegisteredHandler);
    workerEvents.off("worker:disconnected", this.onDisconnectedHandler);
  }
}
