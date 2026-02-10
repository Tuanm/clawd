/**
 * Clawd Agent Bus - Type Definitions
 *
 * Shared types for inter-agent communication via file-based message bus.
 */

// ============================================================================
// Configuration
// ============================================================================

export interface AgentBusConfig {
  /** Human-readable agent name (used as identity on the bus) */
  agent: string;
  /** Agent capabilities for discovery */
  capabilities?: string[];
  /** Additional metadata about this agent */
  metadata?: Record<string, any>;
  /** Base directory for the bus (default: ~/.clawd/projects/{hash}/agent-bus/) */
  busDir?: string;
  /** How often to check for new messages in ms (default: 1000) */
  pollInterval?: number;
}

// ============================================================================
// Messages
// ============================================================================

export interface BusMessage {
  /** Unique message ID */
  id: string;
  /** Sender agent name (auto-filled by plugin, cannot be spoofed) */
  from: string;
  /** Recipient agent name (for direct messages) */
  to: string;
  /** Message type (e.g., "task-request", "task-response", "rpc-request", "rpc-response") */
  type: string;
  /** Message payload (arbitrary JSON) */
  payload: any;
  /** Unix timestamp (ms) */
  timestamp: number;
  /** Reference to original message ID (for request/response correlation) */
  request_id?: string;
}

// ============================================================================
// Topics (Pub/Sub)
// ============================================================================

export interface TopicData {
  /** Topic name */
  topic: string;
  /** Current version (increments with each publish) */
  version: number;
  /** Messages in the topic */
  messages: TopicMessage[];
}

export interface TopicMessage {
  /** Sender agent name */
  from: string;
  /** Message data */
  data: any;
  /** Unix timestamp (ms) */
  ts: number;
}

// ============================================================================
// Registry
// ============================================================================

export interface AgentRegistryEntry {
  /** Agent name */
  name: string;
  /** Agent capabilities */
  capabilities: string[];
  /** Additional metadata */
  metadata: Record<string, any>;
  /** Process ID */
  pid: number;
  /** Registration timestamp (ms) */
  registeredAt: number;
  /** Last heartbeat timestamp (ms) */
  lastHeartbeat: number;
  /** Agent status */
  status: "online" | "offline";
}

export interface AgentRegistry {
  /** All registered agents */
  agents: Record<string, AgentRegistryEntry>;
}
