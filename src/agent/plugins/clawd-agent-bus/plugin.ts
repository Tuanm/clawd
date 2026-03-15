/**
 * Clawd Agent Bus - Plugin Implementation
 *
 * File-based inter-agent communication system.
 *
 * Directory structure:
 *   ~/.clawd/projects/{hash}/agent-bus/
 *     registry.json          -- Agent registry (name, capabilities, status)
 *     inbox/{agentName}/     -- Direct message inbox per agent
 *       msg-{ts}-{rand}.json -- Individual message files
 *     topics/                -- Pub/sub topics
 *       {topic}.json         -- Topic data with message history
 *       .cursors/            -- Per-agent cursor tracking
 *         {agentName}-{topic} -- Last read version per agent per topic
 *
 * Features:
 * - Direct messaging (read-and-delete pattern)
 * - Pub/sub topics (cursor-based tracking)
 * - Agent discovery via registry
 * - fs.watch() for near-real-time notifications
 * - Plugin-enforced identity (from field auto-set)
 * - checkInterrupt() integration for message delivery
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, watch, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Plugin, PluginContext } from "../../src/plugins/manager";
import type { ToolContext, ToolPlugin, ToolRegistration } from "../../src/tools/plugin";
import type { AgentBusConfig, AgentRegistry, AgentRegistryEntry, BusMessage, TopicData, TopicMessage } from "./types";

// ============================================================================
// Helpers
// ============================================================================

function getProjectHash(): string {
  const cwd = process.cwd();
  return createHash("sha256").update(cwd).digest("hex").slice(0, 12);
}

function getDefaultBusDir(): string {
  return join(homedir(), ".clawd", "projects", getProjectHash(), "agent-bus");
}

function ensureDir(dir: string): void {
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

function safeReadJson<T>(path: string, defaultValue: T): T {
  try {
    if (!existsSync(path)) return defaultValue;
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return defaultValue;
  }
}

function safeWriteJson(path: string, data: any): void {
  writeFileSync(path, JSON.stringify(data, null, 2), "utf-8");
}

function generateMessageId(): string {
  const ts = Date.now();
  const rand = Math.random().toString(36).slice(2, 8);
  return `msg-${ts}-${rand}`;
}

// ============================================================================
// Agent Bus Core
// ============================================================================

class AgentBus {
  readonly agentName: string;
  readonly busDir: string;
  readonly inboxDir: string;
  readonly topicsDir: string;
  readonly cursorsDir: string;
  readonly registryPath: string;
  private capabilities: string[];
  private metadata: Record<string, any>;
  private watcher: ReturnType<typeof watch> | null = null;
  private pendingMessages: BusMessage[] = [];
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private interruptedMessageIds: Set<string> = new Set(); // Track messages already reported as interrupts

  constructor(config: AgentBusConfig) {
    this.agentName = config.agent;
    this.busDir = config.busDir || getDefaultBusDir();
    this.inboxDir = join(this.busDir, "inbox", this.agentName);
    this.topicsDir = join(this.busDir, "topics");
    this.cursorsDir = join(this.topicsDir, ".cursors");
    this.registryPath = join(this.busDir, "registry.json");
    this.capabilities = config.capabilities || [];
    this.metadata = config.metadata || {};
  }

  // ============================================================================
  // Lifecycle
  // ============================================================================

  async init(): Promise<void> {
    // Create directories
    ensureDir(this.busDir);
    ensureDir(this.inboxDir);
    ensureDir(this.topicsDir);
    ensureDir(this.cursorsDir);

    // Register in registry
    await this.register();

    // Start watching inbox for new messages
    this.startWatching();

    // Start heartbeat (every 30s)
    this.heartbeatTimer = setInterval(() => this.updateHeartbeat(), 30000);

    // Scan inbox for any messages that arrived before we started watching
    this.scanInbox();
  }

  async shutdown(): Promise<void> {
    // Stop watching
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }

    // Clear debounce timer
    if (this.watchDebounceTimer) {
      clearTimeout(this.watchDebounceTimer);
      this.watchDebounceTimer = null;
    }

    // Stop heartbeat
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }

    // Mark as offline in registry
    this.deregister();
  }

  // ============================================================================
  // Registry
  // ============================================================================

  private async register(): Promise<void> {
    const registry = this.readRegistry();
    registry.agents[this.agentName] = {
      name: this.agentName,
      capabilities: this.capabilities,
      metadata: this.metadata,
      pid: process.pid,
      registeredAt: Date.now(),
      lastHeartbeat: Date.now(),
      status: "online",
    };
    safeWriteJson(this.registryPath, registry);
  }

  private deregister(): void {
    const registry = this.readRegistry();
    if (registry.agents[this.agentName]) {
      registry.agents[this.agentName].status = "offline";
      registry.agents[this.agentName].lastHeartbeat = Date.now();
      safeWriteJson(this.registryPath, registry);
    }
  }

  private updateHeartbeat(): void {
    try {
      const registry = this.readRegistry();
      if (registry.agents[this.agentName]) {
        registry.agents[this.agentName].lastHeartbeat = Date.now();
        registry.agents[this.agentName].status = "online";
        safeWriteJson(this.registryPath, registry);
      }
    } catch {
      // Ignore heartbeat errors
    }
  }

  private readRegistry(): AgentRegistry {
    return safeReadJson<AgentRegistry>(this.registryPath, { agents: {} });
  }

  // ============================================================================
  // Inbox Watching
  // ============================================================================

  /** Debounce timer for fs.watch — coalesces rapid-fire events into a single scanInbox() call */
  private watchDebounceTimer: ReturnType<typeof setTimeout> | null = null;
  private static readonly WATCH_DEBOUNCE_MS = 100;

  private startWatching(): void {
    try {
      this.watcher = watch(this.inboxDir, (eventType, filename) => {
        if (eventType === "rename" && filename && filename.endsWith(".json")) {
          // Debounce: fs.watch() fires multiple events per write on most OSes.
          // Coalesce into a single scan to avoid duplicate message processing.
          if (this.watchDebounceTimer) clearTimeout(this.watchDebounceTimer);
          this.watchDebounceTimer = setTimeout(() => {
            this.watchDebounceTimer = null;
            this.scanInbox();
          }, AgentBus.WATCH_DEBOUNCE_MS);
        }
      });
    } catch (err) {
      console.error(`[AgentBus] Failed to watch inbox: ${err}`);
    }
  }

  private scanInbox(): void {
    try {
      const files = readdirSync(this.inboxDir).filter((f) => f.endsWith(".json"));
      for (const file of files) {
        const filePath = join(this.inboxDir, file);
        try {
          const msg = safeReadJson<BusMessage | null>(filePath, null);
          if (msg && !this.pendingMessages.find((m) => m.id === msg.id)) {
            this.pendingMessages.push(msg);
          }
        } catch {
          // Skip malformed messages
        }
      }
      // Sort by timestamp
      this.pendingMessages.sort((a, b) => a.timestamp - b.timestamp);
    } catch {
      // Inbox may not exist yet
    }
  }

  // ============================================================================
  // Tool Implementations
  // ============================================================================

  /** Register/update agent in the bus */
  agentRegister(capabilities?: string[], metadata?: Record<string, any>): string {
    if (capabilities) this.capabilities = capabilities;
    if (metadata) this.metadata = { ...this.metadata, ...metadata };
    this.register();
    return JSON.stringify({
      success: true,
      agent: this.agentName,
      capabilities: this.capabilities,
      metadata: this.metadata,
    });
  }

  /** Discover other agents on the bus */
  agentDiscover(filter?: { capability?: string; status?: string }): string {
    const registry = this.readRegistry();
    let agents = Object.values(registry.agents);

    // Filter out stale agents (no heartbeat for 2 minutes)
    const staleThreshold = Date.now() - 120000;
    agents = agents.map((agent) => {
      if (agent.status === "online" && agent.lastHeartbeat < staleThreshold) {
        return { ...agent, status: "offline" as const };
      }
      return agent;
    });

    // Apply filters
    if (filter?.capability) {
      agents = agents.filter((a) => a.capabilities.includes(filter.capability!));
    }
    if (filter?.status) {
      agents = agents.filter((a) => a.status === filter.status);
    }

    return JSON.stringify({
      success: true,
      agents: agents.map((a) => ({
        name: a.name,
        capabilities: a.capabilities,
        status: a.status,
        metadata: a.metadata,
        lastHeartbeat: a.lastHeartbeat,
      })),
      count: agents.length,
    });
  }

  /** Send a direct message to another agent */
  agentSend(to: string, type: string, payload: any, requestId?: string): string {
    const targetInbox = join(this.busDir, "inbox", to);

    // Check if target inbox exists (agent is registered)
    if (!existsSync(targetInbox)) {
      // Create inbox for the target -- they might not have started yet
      ensureDir(targetInbox);
    }

    const msg: BusMessage = {
      id: generateMessageId(),
      from: this.agentName, // Plugin-enforced identity
      to,
      type,
      payload,
      timestamp: Date.now(),
      request_id: requestId,
    };

    const filePath = join(targetInbox, `${msg.id}.json`);
    safeWriteJson(filePath, msg);

    return JSON.stringify({
      success: true,
      messageId: msg.id,
      to,
      type,
    });
  }

  /** Receive messages from inbox (read-and-delete) */
  agentReceive(limit?: number, type?: string): string {
    // Scan for any new messages
    this.scanInbox();

    let messages = [...this.pendingMessages];

    // Filter by type if specified
    if (type) {
      messages = messages.filter((m) => m.type === type);
    }

    // Limit results
    const maxMessages = limit || 10;
    const toReturn = messages.slice(0, maxMessages);

    // Delete returned messages from disk and pending queue
    for (const msg of toReturn) {
      const filePath = join(this.inboxDir, `${msg.id}.json`);
      try {
        if (existsSync(filePath)) {
          unlinkSync(filePath);
        }
      } catch {
        // File may have already been deleted
      }
      const idx = this.pendingMessages.findIndex((m) => m.id === msg.id);
      if (idx >= 0) this.pendingMessages.splice(idx, 1);
      // Clean up interrupt tracking for consumed messages
      this.interruptedMessageIds.delete(msg.id);
    }

    return JSON.stringify({
      success: true,
      messages: toReturn,
      count: toReturn.length,
      remaining: this.pendingMessages.length,
    });
  }

  /** Publish a message to a topic */
  agentPublish(topic: string, data: any): string {
    const topicPath = join(this.topicsDir, `${topic}.json`);
    const topicData = safeReadJson<TopicData>(topicPath, {
      topic,
      version: 0,
      messages: [],
    });

    const message: TopicMessage = {
      from: this.agentName,
      data,
      ts: Date.now(),
    };

    topicData.version++;
    topicData.messages.push(message);

    // Keep last 100 messages per topic
    if (topicData.messages.length > 100) {
      topicData.messages = topicData.messages.slice(-100);
    }

    safeWriteJson(topicPath, topicData);

    return JSON.stringify({
      success: true,
      topic,
      version: topicData.version,
    });
  }

  /** Subscribe to a topic and read new messages since last cursor */
  agentSubscribe(topic: string): string {
    const topicPath = join(this.topicsDir, `${topic}.json`);
    const cursorPath = join(this.cursorsDir, `${this.agentName}-${topic}`);

    if (!existsSync(topicPath)) {
      return JSON.stringify({
        success: true,
        topic,
        messages: [],
        count: 0,
        version: 0,
      });
    }

    const topicData = safeReadJson<TopicData>(topicPath, {
      topic,
      version: 0,
      messages: [],
    });

    // Read cursor (last seen version)
    let lastVersion = 0;
    try {
      if (existsSync(cursorPath)) {
        lastVersion = parseInt(readFileSync(cursorPath, "utf-8").trim(), 10) || 0;
      }
    } catch {
      lastVersion = 0;
    }

    // Get messages published after the cursor
    // Since version increments by 1 per message, we can use array offset
    const startIdx = Math.max(0, topicData.messages.length - (topicData.version - lastVersion));
    const newMessages = topicData.messages.slice(startIdx);

    // Update cursor
    writeFileSync(cursorPath, String(topicData.version), "utf-8");

    return JSON.stringify({
      success: true,
      topic,
      messages: newMessages,
      count: newMessages.length,
      version: topicData.version,
      previousVersion: lastVersion,
    });
  }

  /** RPC: Send a request and wait for a response */
  async agentRequest(to: string, action: string, params: any, timeout: number = 30000): Promise<string> {
    const requestId = generateMessageId();

    // Send the request
    this.agentSend(to, "rpc-request", { action, params }, requestId);

    // Poll for response
    const startTime = Date.now();
    const pollInterval = 500;

    while (Date.now() - startTime < timeout) {
      // Scan inbox for response
      this.scanInbox();

      const responseIdx = this.pendingMessages.findIndex(
        (m) => m.request_id === requestId && m.type === "rpc-response",
      );

      if (responseIdx >= 0) {
        const response = this.pendingMessages[responseIdx];
        // Remove from pending and delete file
        this.pendingMessages.splice(responseIdx, 1);
        const filePath = join(this.inboxDir, `${response.id}.json`);
        try {
          if (existsSync(filePath)) unlinkSync(filePath);
        } catch {
          /* ignore */
        }

        return JSON.stringify({
          success: true,
          requestId,
          from: response.from,
          payload: response.payload,
        });
      }

      // Wait before polling again
      await new Promise((resolve) => setTimeout(resolve, pollInterval));
    }

    return JSON.stringify({
      success: false,
      error: `Request to ${to} timed out after ${timeout}ms`,
      requestId,
    });
  }

  // ============================================================================
  // Interrupt Check
  // ============================================================================

  /** Check for pending messages (called by checkInterrupt hook) */
  checkForMessages(): string | null {
    this.scanInbox();

    // Only report messages that haven't been reported as interrupts yet
    const newMessages = this.pendingMessages.filter((m) => !this.interruptedMessageIds.has(m.id));

    if (newMessages.length === 0) return null;

    // Mark these messages as reported so we don't interrupt again for the same ones
    for (const msg of newMessages) {
      this.interruptedMessageIds.add(msg.id);
    }

    // Peek at messages without consuming them
    // The agent will use agent_receive to actually consume
    const preview = newMessages.map((m) => ({
      id: m.id,
      from: m.from,
      type: m.type,
      preview: typeof m.payload === "string" ? m.payload.slice(0, 200) : JSON.stringify(m.payload).slice(0, 200),
    }));

    return `[AGENT-BUS] You have ${newMessages.length} new message(s) in your inbox:\n${JSON.stringify(preview, null, 2)}\n\nUse agent_receive() to read and process them.`;
  }
}

// ============================================================================
// Plugin + ToolPlugin Factory
// ============================================================================

export interface AgentBusPluginResult {
  /** The Plugin for PluginManager (hooks, lifecycle) */
  plugin: Plugin;
  /** The ToolPlugin for ToolPluginManager (tool registration) */
  toolPlugin: ToolPlugin;
}

export function createAgentBusPlugin(config: AgentBusConfig): AgentBusPluginResult {
  const bus = new AgentBus(config);

  // ============================================================================
  // ToolPlugin implementation (registers tools)
  // ============================================================================

  const toolPlugin: ToolPlugin = {
    name: "clawd-agent-bus",

    getTools(): ToolRegistration[] {
      return [
        {
          name: "agent_register",
          description:
            "Register or update this agent on the bus. Updates capabilities and metadata visible to other agents.",
          parameters: {
            capabilities: {
              type: "array",
              description: "List of capability strings (e.g., ['api', 'db', 'testing'])",
              items: { type: "string" },
            },
            metadata: {
              type: "object",
              description: "Additional metadata about this agent (arbitrary key-value pairs)",
            },
          },
          required: [],
          handler: async (args) => {
            try {
              const result = bus.agentRegister(args.capabilities, args.metadata);
              return { success: true, output: result };
            } catch (err: any) {
              return { success: false, output: "", error: err.message };
            }
          },
        },
        {
          name: "agent_discover",
          description:
            "Discover other agents on the bus. Returns their names, capabilities, status, and metadata. Optionally filter by capability or status.",
          parameters: {
            capability: {
              type: "string",
              description: "Filter agents by capability (e.g., 'api', 'testing')",
            },
            status: {
              type: "string",
              description: "Filter by status: 'online' or 'offline'",
              enum: ["online", "offline"],
            },
          },
          required: [],
          handler: async (args) => {
            try {
              const result = bus.agentDiscover({
                capability: args.capability,
                status: args.status,
              });
              return { success: true, output: result };
            } catch (err: any) {
              return { success: false, output: "", error: err.message };
            }
          },
        },
        {
          name: "agent_send",
          description:
            "Send a direct message to another agent. The message is written to the target agent's inbox. The 'from' field is automatically set to your agent name (cannot be spoofed).",
          parameters: {
            to: {
              type: "string",
              description: "Target agent name",
            },
            type: {
              type: "string",
              description: "Message type (e.g., 'task-request', 'task-response', 'info', 'rpc-response')",
            },
            payload: {
              type: "object",
              description: "Message payload (arbitrary JSON data)",
            },
            request_id: {
              type: "string",
              description:
                "Reference to original message ID (for replies/correlation). Set this when responding to a specific message.",
            },
          },
          required: ["to", "type", "payload"],
          handler: async (args) => {
            try {
              const result = bus.agentSend(args.to, args.type, args.payload, args.request_id);
              return { success: true, output: result };
            } catch (err: any) {
              return { success: false, output: "", error: err.message };
            }
          },
        },
        {
          name: "agent_receive",
          description:
            "Read messages from your inbox. Messages are deleted after reading (read-and-delete pattern). Returns an array of messages sorted by timestamp.",
          parameters: {
            limit: {
              type: "number",
              description: "Maximum number of messages to return (default: 10)",
            },
            type: {
              type: "string",
              description: "Filter messages by type (e.g., 'task-request', 'rpc-request')",
            },
          },
          required: [],
          handler: async (args) => {
            try {
              const result = bus.agentReceive(args.limit, args.type);
              return { success: true, output: result };
            } catch (err: any) {
              return { success: false, output: "", error: err.message };
            }
          },
        },
        {
          name: "agent_publish",
          description:
            "Publish a message to a topic. All agents subscribed to the topic will see it on their next subscribe call.",
          parameters: {
            topic: {
              type: "string",
              description: "Topic name (e.g., 'build-status', 'test-results')",
            },
            data: {
              type: "object",
              description: "Data to publish (arbitrary JSON)",
            },
          },
          required: ["topic", "data"],
          handler: async (args) => {
            try {
              const result = bus.agentPublish(args.topic, args.data);
              return { success: true, output: result };
            } catch (err: any) {
              return { success: false, output: "", error: err.message };
            }
          },
        },
        {
          name: "agent_subscribe",
          description:
            "Read new messages from a topic since your last read. Uses cursor-based tracking so you only see messages published after your last subscribe call.",
          parameters: {
            topic: {
              type: "string",
              description: "Topic name to subscribe to",
            },
          },
          required: ["topic"],
          handler: async (args) => {
            try {
              const result = bus.agentSubscribe(args.topic);
              return { success: true, output: result };
            } catch (err: any) {
              return { success: false, output: "", error: err.message };
            }
          },
        },
        {
          name: "agent_request",
          description:
            "Send an RPC request to another agent and wait for a response. This is a convenience wrapper that sends a message with type 'rpc-request' and polls for a matching 'rpc-response' with the same request_id. The target agent should use agent_send with type='rpc-response' and the same request_id to reply.",
          parameters: {
            to: {
              type: "string",
              description: "Target agent name",
            },
            action: {
              type: "string",
              description: "Action to request (e.g., 'run-tests', 'review-code')",
            },
            params: {
              type: "object",
              description: "Parameters for the action",
            },
            timeout: {
              type: "number",
              description: "Timeout in milliseconds (default: 30000)",
            },
          },
          required: ["to", "action"],
          handler: async (args) => {
            try {
              const result = await bus.agentRequest(args.to, args.action, args.params || {}, args.timeout || 30000);
              return { success: true, output: result };
            } catch (err: any) {
              return { success: false, output: "", error: err.message };
            }
          },
        },
      ];
    },
  };

  // ============================================================================
  // Plugin implementation (hooks for lifecycle + interrupts)
  // ============================================================================

  const plugin: Plugin = {
    name: "clawd-agent-bus",
    version: "1.0.0",
    description: "File-based inter-agent communication bus with direct messaging and pub/sub",

    hooks: {
      async onInit(_ctx: PluginContext) {
        await bus.init();
        console.log(`[AgentBus] Agent "${config.agent}" registered on bus at ${bus.busDir}`);
      },

      async onShutdown() {
        await bus.shutdown();
        console.log(`[AgentBus] Agent "${config.agent}" deregistered from bus`);
      },

      async getSystemContext(_ctx: PluginContext): Promise<string | null> {
        return `<agent_bus>
You are connected to the Agent Bus as "${config.agent}".
Capabilities: ${(config.capabilities || []).join(", ") || "none specified"}

You can communicate with other agents using these tools:
- agent_discover() -- Find other agents and their capabilities
- agent_send(to, type, payload) -- Send a direct message to another agent
- agent_receive() -- Read messages from your inbox
- agent_publish(topic, data) -- Publish to a topic
- agent_subscribe(topic) -- Read new topic messages
- agent_request(to, action, params) -- RPC call (send + wait for response)

When you receive an rpc-request, reply using:
  agent_send(to=<sender>, type="rpc-response", payload={...}, request_id=<original_id>)

Messages in your inbox will be delivered via interrupts. Use agent_receive() to read them.
</agent_bus>`;
      },

      async checkInterrupt(_ctx: PluginContext): Promise<string | null> {
        return bus.checkForMessages();
      },
    },
  };

  return { plugin, toolPlugin };
}
