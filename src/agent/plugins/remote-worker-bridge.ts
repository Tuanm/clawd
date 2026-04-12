/**
 * Remote Worker Bridge
 *
 * Bridges server-side workerEvents → agent-side MCPManager.
 * NOT a ToolPlugin — tools flow through MCPManager.addConnection() path.
 * Listens for worker registration/disconnect events and manages MCP connections.
 */

import { createHash } from "crypto";
import { getConnectedWorker, getTokenChannels, workerEvents } from "../../server/remote-worker";
import { matchesPattern } from "../../utils/pattern";
import type { MCPManager } from "../mcp/client";
import { RemoteWorkerMCPConnection } from "../mcp/remote-worker-connection";

interface WorkerRegistrationInfo {
  tokenHash: string;
  name: string;
  projectRoot: string;
  platform: string;
  tools: Array<{ name: string; inputSchema: any; description: string }>;
  channels: string[] | "all";
}

interface WorkerDisconnectInfo {
  tokenHash: string;
  name: string;
}

export class RemoteWorkerBridge {
  private mcpManager: MCPManager;
  private agentWorkerToken: string | undefined;
  private agentTokenHash: string | undefined;
  private channel: string;
  private destroyed = false;
  private managedConnections = new Set<string>();

  private onRegisteredHandler: (info: WorkerRegistrationInfo) => void;
  private onDisconnectedHandler: (info: WorkerDisconnectInfo) => void;

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
        channels: getTokenChannels(this.agentWorkerToken!),
      });
    }
  }

  private async addWorkerConnection(info: WorkerRegistrationInfo) {
    if (this.destroyed) return;
    if (!this.agentTokenHash) return;
    if (info.tokenHash !== this.agentTokenHash) return;

    // Check channel authorization (use glob matching for pattern support)
    if (info.channels !== "all") {
      const authorized = info.channels.some((ch) => matchesPattern(this.channel, ch));
      if (!authorized) return;
    }

    const conn = new RemoteWorkerMCPConnection(info.tokenHash, info.name, info.tools);
    console.log(`[RemoteWorkerBridge] Adding ${conn.name} with ${info.tools.length} tools`);
    await this.mcpManager.addConnection(conn);

    // Re-check after async — disconnect or destroy may have fired during addConnection
    if (this.destroyed) {
      this.mcpManager.removeConnection(conn.name).catch(() => {});
      return;
    }

    // Verify worker is still connected — if it disconnected during addConnection,
    // the disconnect handler would have no-oped (managedConnections didn't contain it yet)
    const still = getConnectedWorker(info.tokenHash);
    if (!still || still.status !== "connected") {
      this.mcpManager.removeConnection(conn.name).catch(() => {});
      return;
    }

    this.managedConnections.add(conn.name);
  }

  private onWorkerRegistered(info: WorkerRegistrationInfo) {
    if (info.tokenHash === this.agentTokenHash) {
      console.log(
        `[RemoteWorkerBridge] Worker registered: ${info.name} (${info.tools.length} tools) for channel ${this.channel}`,
      );
    }
    this.addWorkerConnection(info).catch(console.error);
  }

  private onWorkerDisconnected(info: WorkerDisconnectInfo) {
    if (this.destroyed) return;
    if (info.tokenHash !== this.agentTokenHash) return;
    const connName = `remote-worker-${info.name}`;
    this.managedConnections.delete(connName);
    this.mcpManager.removeConnection(connName).catch(() => {});
  }

  destroy() {
    this.destroyed = true;
    workerEvents.off("worker:registered", this.onRegisteredHandler);
    workerEvents.off("worker:disconnected", this.onDisconnectedHandler);

    // Clean up all managed connections from MCPManager
    for (const connName of this.managedConnections) {
      this.mcpManager.removeConnection(connName).catch(() => {});
    }
    this.managedConnections.clear();
  }
}
