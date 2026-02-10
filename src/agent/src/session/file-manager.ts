/**
 * File-based Session Management (like Copilot CLI)
 *
 * Structure:
 * ~/.clawd/agents/{channel}-{agent}/
 * ├── session-state/
 * │   └── {session-uuid}/
 * │       ├── workspace.yaml   - Session metadata & summary
 * │       ├── events.jsonl     - Full event history
 * │       ├── context.json     - Current context (messages to send to LLM)
 * │       └── checkpoints/     - Compacted context snapshots
 * └── logs/
 */

import { join } from "node:path";
import { homedir } from "node:os";
import { mkdirSync, existsSync, readFileSync, writeFileSync, appendFileSync, readdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import type { Message } from "../api/client";

// ============================================================================
// Types
// ============================================================================

export interface FileSession {
  id: string;
  channel: string;
  agentId: string;
  model: string;
  created_at: string;
  updated_at: string;
  summary?: string;
  summaryCount: number;
}

export interface SessionEvent {
  type: string;
  data: any;
  id: string;
  timestamp: string;
  parentId?: string | null;
}

export interface ContextMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: any[];
  tool_call_id?: string;
}

// ============================================================================
// File Session Manager
// ============================================================================

export class FileSessionManager {
  private baseDir: string;
  private channel: string;
  private agentId: string;
  private sessionDir: string | null = null;
  private session: FileSession | null = null;

  constructor(channel: string, agentId: string) {
    this.channel = channel;
    this.agentId = agentId.replace(/[^a-zA-Z0-9-_]/g, "_");
    this.baseDir = join(homedir(), ".clawd", "agents", `${channel}-${this.agentId}`);

    // Ensure base directory exists
    mkdirSync(join(this.baseDir, "session-state"), { recursive: true });
    mkdirSync(join(this.baseDir, "logs"), { recursive: true });
  }

  // ============================================================================
  // Quick Checks (for optimized startup)
  // ============================================================================

  /**
   * Check if we have a valid cached context (for fast startup)
   * Returns true if context.json exists and is less than 1 hour old
   */
  hasValidContext(): boolean {
    const sessionStateDir = join(this.baseDir, "session-state");
    try {
      const sessions = readdirSync(sessionStateDir).filter((f) => existsSync(join(sessionStateDir, f, "context.json")));

      if (sessions.length === 0) return false;

      // Check if context file is recent (less than 1 hour old)
      const contextPath = join(sessionStateDir, sessions[0], "context.json");
      const stats = require("node:fs").statSync(contextPath);
      const ageMs = Date.now() - stats.mtimeMs;
      const maxAge = 60 * 60 * 1000; // 1 hour

      return ageMs < maxAge;
    } catch {
      return false;
    }
  }

  /**
   * Update context from DB messages (for background refresh)
   */
  updateContextFromDb(dbMessages: any[]): void {
    if (!this.sessionDir) return;

    // Convert DB messages to context format
    const context: ContextMessage[] = dbMessages.map((msg) => ({
      role: msg.user === "UHUMAN" ? ("user" as const) : ("assistant" as const),
      content: msg.text || "",
      tool_calls: undefined,
      tool_call_id: undefined,
    }));

    this.saveContext(context);

    // Update session metadata
    if (this.session) {
      this.session.updated_at = new Date().toISOString();
      this.saveSessionMetadata();
    }
  }

  // ============================================================================
  // Session Management
  // ============================================================================

  getOrCreateSession(model: string, dbMessages?: any[]): FileSession {
    // Try to find existing session
    const sessionStateDir = join(this.baseDir, "session-state");
    const sessions = readdirSync(sessionStateDir).filter((f) => existsSync(join(sessionStateDir, f, "workspace.yaml")));

    if (sessions.length > 0) {
      // Use most recent session (by directory name which is UUID, but we'll check updated_at)
      const latestSession = sessions[0]; // For now, just use first one
      this.sessionDir = join(sessionStateDir, latestSession);
      this.session = this.loadSessionMetadata();

      // Check if context.json exists - if not, need to reconstruct
      const contextPath = join(this.sessionDir, "context.json");
      if (!existsSync(contextPath) && dbMessages && dbMessages.length > 0) {
        console.log("[FileSession] Context missing, reconstructing from DB...");
        this.reconstructFromDb(dbMessages);
      }

      return this.session!;
    }

    // No existing session - create new one
    // If we have DB messages, reconstruct context from them
    const session = this.createSession(model);
    if (dbMessages && dbMessages.length > 0) {
      console.log("[FileSession] New session, initializing from DB history...");
      this.reconstructFromDb(dbMessages);
    }
    return session;
  }

  /**
   * Reconstruct session context from database messages
   * This is called when session files are lost or for new agents joining a channel
   */
  reconstructFromDb(dbMessages: any[]): void {
    if (!this.sessionDir) return;

    // Convert DB messages to context format
    const context: ContextMessage[] = dbMessages.map((msg) => ({
      role: msg.user === "UHUMAN" ? ("user" as const) : ("assistant" as const),
      content: msg.text || "",
      tool_calls: undefined,
      tool_call_id: undefined,
    }));

    // Save reconstructed context
    this.saveContext(context);

    // Log reconstruction event
    this.appendEvent({
      type: "session.reconstruct",
      data: {
        source: "database",
        messageCount: dbMessages.length,
        reconstructedAt: new Date().toISOString(),
      },
    });

    // Update session metadata
    if (this.session) {
      this.session.summary = `Reconstructed from ${dbMessages.length} DB messages`;
      this.session.updated_at = new Date().toISOString();
      this.saveSessionMetadata();
    }
  }

  /**
   * Check if session needs reconstruction (missing context files)
   */
  needsReconstruction(): boolean {
    if (!this.sessionDir) return true;
    const contextPath = join(this.sessionDir, "context.json");
    return !existsSync(contextPath);
  }

  createSession(model: string): FileSession {
    const sessionId = randomUUID();
    this.sessionDir = join(this.baseDir, "session-state", sessionId);
    mkdirSync(this.sessionDir, { recursive: true });
    mkdirSync(join(this.sessionDir, "checkpoints"), { recursive: true });

    const now = new Date().toISOString();
    this.session = {
      id: sessionId,
      channel: this.channel,
      agentId: this.agentId,
      model,
      created_at: now,
      updated_at: now,
      summaryCount: 0,
    };

    this.saveSessionMetadata();

    // Write initial event
    this.appendEvent({
      type: "session.start",
      data: {
        sessionId,
        channel: this.channel,
        agentId: this.agentId,
        model,
        startTime: now,
      },
    });

    return this.session;
  }

  private loadSessionMetadata(): FileSession | null {
    if (!this.sessionDir) return null;
    const yamlPath = join(this.sessionDir, "workspace.yaml");
    if (!existsSync(yamlPath)) return null;

    const content = readFileSync(yamlPath, "utf-8");
    // Simple YAML parsing (key: value format)
    const lines = content.split("\n");
    const data: any = {};
    let currentKey = "";
    let inMultiline = false;
    let multilineValue = "";

    for (const line of lines) {
      if (inMultiline) {
        if (line.startsWith("  ")) {
          multilineValue += `${line.slice(2)}\n`;
        } else {
          data[currentKey] = multilineValue.trim();
          inMultiline = false;
        }
      }

      if (!inMultiline) {
        const match = line.match(/^(\w+):\s*(.*)$/);
        if (match) {
          const [, key, value] = match;
          if (value === "|-" || value === "|") {
            currentKey = key;
            inMultiline = true;
            multilineValue = "";
          } else {
            data[key] = value;
          }
        }
      }
    }

    return {
      id: data.id,
      channel: this.channel,
      agentId: this.agentId,
      model: data.model || "claude-opus-4.6",
      created_at: data.created_at,
      updated_at: data.updated_at,
      summary: data.summary,
      summaryCount: parseInt(data.summary_count || "0", 10),
    };
  }

  private saveSessionMetadata(): void {
    if (!this.sessionDir || !this.session) return;

    const yamlPath = join(this.sessionDir, "workspace.yaml");
    let content = `id: ${this.session.id}
channel: ${this.session.channel}
agent_id: ${this.session.agentId}
model: ${this.session.model}
created_at: ${this.session.created_at}
updated_at: ${this.session.updated_at}
summary_count: ${this.session.summaryCount}
`;

    if (this.session.summary) {
      content += `summary: |-\n  ${this.session.summary.split("\n").join("\n  ")}\n`;
    }

    writeFileSync(yamlPath, content);
  }

  // ============================================================================
  // Event Logging
  // ============================================================================

  appendEvent(event: Omit<SessionEvent, "id" | "timestamp">): void {
    if (!this.sessionDir) return;

    const fullEvent: SessionEvent = {
      ...event,
      id: randomUUID(),
      timestamp: new Date().toISOString(),
    };

    const eventsPath = join(this.sessionDir, "events.jsonl");
    appendFileSync(eventsPath, `${JSON.stringify(fullEvent)}\n`);
  }

  // ============================================================================
  // Context Management
  // ============================================================================

  saveContext(messages: ContextMessage[]): void {
    if (!this.sessionDir) return;

    const contextPath = join(this.sessionDir, "context.json");
    writeFileSync(contextPath, JSON.stringify(messages, null, 2));

    // Update session metadata
    if (this.session) {
      this.session.updated_at = new Date().toISOString();
      this.saveSessionMetadata();
    }
  }

  loadContext(): ContextMessage[] {
    if (!this.sessionDir) return [];

    const contextPath = join(this.sessionDir, "context.json");
    if (!existsSync(contextPath)) return [];

    try {
      return JSON.parse(readFileSync(contextPath, "utf-8"));
    } catch {
      return [];
    }
  }

  // ============================================================================
  // Message Storage (for compatibility with existing code)
  // ============================================================================

  addMessage(message: Message): void {
    // Log as event
    this.appendEvent({
      type: message.role === "user" ? "user.message" : "assistant.message",
      data: {
        role: message.role,
        content: message.content,
        tool_calls: message.tool_calls,
        tool_call_id: message.tool_call_id,
      },
    });
  }

  getRecentMessages(limit: number = 50): Message[] {
    // Load from context.json (which contains the active context)
    const context = this.loadContext();

    // Filter out system messages and return last N
    const nonSystem = context.filter((m) => m.role !== "system");
    return nonSystem.slice(-limit).map((m) => ({
      role: m.role as any,
      content: m.content,
      tool_calls: m.tool_calls,
      tool_call_id: m.tool_call_id,
    }));
  }

  // ============================================================================
  // Checkpoint Management
  // ============================================================================

  saveCheckpoint(summary: string, messages: ContextMessage[]): void {
    if (!this.sessionDir || !this.session) return;

    const checkpointId = Date.now().toString();
    const checkpointDir = join(this.sessionDir, "checkpoints", checkpointId);
    mkdirSync(checkpointDir, { recursive: true });

    // Save checkpoint context
    writeFileSync(join(checkpointDir, "context.json"), JSON.stringify(messages, null, 2));
    writeFileSync(join(checkpointDir, "summary.txt"), summary);

    // Update session summary
    this.session.summary = summary;
    this.session.summaryCount++;
    this.saveSessionMetadata();
  }

  getSession(): FileSession | null {
    return this.session;
  }

  getSessionDir(): string | null {
    return this.sessionDir;
  }
}
