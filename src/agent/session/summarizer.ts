/**
 * Summarization Sidecar Agent
 *
 * Runs in background to periodically compact old messages into summaries.
 * Uses the database as source of truth and updates session files.
 * Checkpoints are stored in-memory with optional DB persistence for recovery.
 */

import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { FileSessionManager } from "./file-manager";
import { SessionManager } from "./manager";

export interface SummarizerConfig {
  channel: string;
  agentId: string;
  serverUrl: string;
  /** Copilot API token (if available - enables LLM summarization) */
  token?: string;
  /** Model to use for summarization (same as agent) */
  model?: string;
  /** Threshold: summarize when context exceeds this many messages */
  messageThreshold: number;
  /** How many recent messages to keep unsummarized */
  keepRecentCount: number;
  /** Interval in ms to check if summarization needed */
  checkInterval: number;
  /** Optional: path to write checkpoint files (undefined = in-memory + DB recovery, Option C) */
  checkpointFilePath?: string;
}

export interface SummaryCheckpoint {
  id: string;
  createdAt: string;
  fromTs: string;
  toTs: string;
  messageCount: number;
  summary: string;
}

export class SessionSummarizer {
  private config: SummarizerConfig;
  private fileSession: FileSessionManager;
  private intervalId?: NodeJS.Timeout;
  private isRunning = false;
  /** Promise-based guard against concurrent checkAndSummarize() calls */
  private processingPromise: Promise<void> | null = null;
  /** In-memory checkpoint storage (used when file writing is disabled, Option C) */
  private checkpoints: SummaryCheckpoint[] = [];
  /** Maximum checkpoints to keep in memory before eviction (prevents memory leak) */
  private readonly MAX_CHECKPOINTS = 100;
  /** Lazy-initialized SessionManager for DB operations */
  private _manager?: SessionManager;
  /** Cached session name for consistent lookups */
  private readonly _sessionName: string;

  constructor(
    config: Partial<SummarizerConfig> & {
      channel: string;
      agentId: string;
      serverUrl: string;
    },
  ) {
    this.config = {
      messageThreshold: 50,
      keepRecentCount: 20,
      checkInterval: 60000,
      ...config,
    };
    this.fileSession = new FileSessionManager(this.config.channel, this.config.agentId);
    this._sessionName = `${this.config.channel}-${this.config.agentId.replace(/[^a-zA-Z0-9]/g, "_")}`;

    if (!this.config.checkpointFilePath) {
      this.restoreCheckpointsFromDb();
    }
  }

  private get manager(): SessionManager {
    if (!this._manager) {
      this._manager = new SessionManager();
    }
    return this._manager;
  }

  /**
   * Restore checkpoints from DB on startup (for in-memory mode)
   */
  private restoreCheckpointsFromDb(): void {
    try {
      const session = this.manager.getSession(this._sessionName);
      if (!session) return;

      const rows = this.manager.getSummarizerCheckpoints(session.id);
      this.checkpoints = rows;
      if (this.checkpoints.length > 0) {
        console.log(`[Summarizer] Restored ${this.checkpoints.length} checkpoints from DB`);
      }
    } catch (err) {
      console.error("[Summarizer] Failed to restore checkpoints from DB:", err);
    }
  }

  /**
   * Persist checkpoint to DB (for in-memory mode recovery)
   */
  private persistCheckpointToDb(checkpoint: SummaryCheckpoint): void {
    try {
      const session = this.manager.getSession(this._sessionName);
      if (!session) return;

      this.manager.saveSummarizerCheckpoint(session.id, checkpoint);
    } catch (err) {
      console.error("[Summarizer] Failed to persist checkpoint to DB:", err);
    }
  }

  /**
   * Start the background summarization loop
   */
  start(): void {
    if (this.isRunning) return;
    this.isRunning = true;

    console.log(`[Summarizer] Started for ${this.config.channel}/${this.config.agentId}`);
    console.log(`[Summarizer] Threshold: ${this.config.messageThreshold}, Keep recent: ${this.config.keepRecentCount}`);

    this.checkAndSummarize();
    this.intervalId = setInterval(() => this.checkAndSummarize(), this.config.checkInterval);
  }

  /**
   * Stop the background loop
   */
  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = undefined;
    }
    this.isRunning = false;
    console.log("[Summarizer] Stopped");
  }

  /**
   * Check if summarization is needed and run if so
   * Guard against concurrent execution using Promise-based queue
   */
  async checkAndSummarize(): Promise<void> {
    // If already processing, wait for it to complete instead of racing
    if (this.processingPromise) {
      await this.processingPromise;
      return;
    }

    this.processingPromise = this._doSummarize();
    try {
      await this.processingPromise;
    } finally {
      this.processingPromise = null;
    }
  }

  /**
   * Internal summarization logic
   */
  private async _doSummarize(): Promise<void> {
    try {
      const messages = this.fetchDbMessages();

      if (messages.length < this.config.messageThreshold) {
        return;
      }

      const lastCheckpoint = this.getLastCheckpoint();
      const lastSummarizedTs = lastCheckpoint?.toTs || "0";

      const unsummarizedMessages = messages.filter((m) => m.ts > lastSummarizedTs);

      if (unsummarizedMessages.length < this.config.messageThreshold - this.config.keepRecentCount) {
        return;
      }

      console.log(`[Summarizer] ${unsummarizedMessages.length} unsummarized messages, running summarization...`);

      const messagesToSummarize = unsummarizedMessages.slice(0, -this.config.keepRecentCount);

      if (messagesToSummarize.length < 10) {
        return;
      }

      await this.createSummary(messagesToSummarize);
    } catch (err) {
      console.error("[Summarizer] Error:", err);
    }
  }

  /**
   * Fetch messages from the session database directly (no network hop).
   *
   * Uses the SessionManager keyed to `channel-agentId` and maps model-level
   * messages to the Slack-style shape expected by checkAndSummarize /
   * createSummary.
   */
  private fetchDbMessages(): any[] {
    try {
      const manager = new SessionManager();
      const sessionName = `${this.config.channel}-${this.config.agentId.replace(/[^a-zA-Z0-9]/g, "_")}`;
      const session = manager.getSession(sessionName);
      if (!session) return [];

      const messages = manager.getMessages(session.id);

      // Map model-level messages to a Slack-style shape for createSummary()
      return messages.map((msg, idx) => ({
        ts: String(idx),
        user: msg.role === "user" ? "UHUMAN" : "UBOT",
        agent_id: msg.role === "assistant" ? this.config.agentId : null,
        text: typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content ?? ""),
      }));
    } catch (err) {
      console.error("[Summarizer] Failed to fetch DB messages:", err);
      return [];
    }
  }

  /**
   * Get the most recent checkpoint (in-memory only, no disk reads when checkpointFilePath not set)
   */
  private getLastCheckpoint(): SummaryCheckpoint | null {
    if (!this.config.checkpointFilePath) {
      return this.checkpoints.length > 0 ? this.checkpoints[this.checkpoints.length - 1] : null;
    }

    const sessionDir = this.fileSession.getSessionDir();
    if (!sessionDir) return null;

    const checkpointsDir = join(sessionDir, "checkpoints");
    if (!existsSync(checkpointsDir)) return null;

    const indexPath = join(checkpointsDir, "index.json");
    if (!existsSync(indexPath)) return null;
    try {
      const index = JSON.parse(readFileSync(indexPath, "utf-8")) as SummaryCheckpoint[];
      return index.length > 0 ? index[index.length - 1] : null;
    } catch {
      return null;
    }
  }

  /**
   * Create a summary checkpoint from messages (in-memory only by default, Option C)
   */
  private async createSummary(messages: any[]): Promise<void> {
    const conversationText = messages
      .map((m) => {
        const role = m.user === "UHUMAN" ? "Human" : m.agent_id || "Bot";
        return `[${role}]: ${m.text}`;
      })
      .join("\n\n");

    const summary = await this.generateSummary(conversationText, messages.length);

    const checkpoint: SummaryCheckpoint = {
      id: `checkpoint-${Date.now()}-${randomUUID().substring(0, 8)}`,
      createdAt: new Date().toISOString(),
      fromTs: messages[0].ts,
      toTs: messages[messages.length - 1].ts,
      messageCount: messages.length,
      summary,
    };

    // Eviction fires at > MAX_CHECKPOINTS to keep array bounded
    if (this.checkpoints.length > this.MAX_CHECKPOINTS) {
      this.checkpoints = this.checkpoints.slice(-Math.floor(this.MAX_CHECKPOINTS / 2));
    }
    this.checkpoints.push(checkpoint);

    if (!this.config.checkpointFilePath) {
      this.persistCheckpointToDb(checkpoint);
    } else {
      this.writeCheckpointToFile(checkpoint);
    }

    console.log(
      `[Summarizer] Created checkpoint: ${checkpoint.id} (${checkpoint.messageCount} messages, mode: ${this.config.checkpointFilePath ? "file" : "memory+DB"})`,
    );
  }

  /**
   * Write checkpoint to disk (only when file writing is explicitly enabled via checkpointFilePath)
   * Errors are logged but not thrown - checkpoint is already safely stored in-memory
   */
  private writeCheckpointToFile(checkpoint: SummaryCheckpoint): void {
    try {
      const dir = this.config.checkpointFilePath!;
      const checkpointsDir = join(dir, "checkpoints");
      mkdirSync(checkpointsDir, { recursive: true });

      const checkpointPath = join(checkpointsDir, `${checkpoint.id}.md`);
      writeFileSync(
        checkpointPath,
        `# Checkpoint: ${checkpoint.id}\n\n` +
          `**Created:** ${checkpoint.createdAt}\n` +
          `**Messages:** ${checkpoint.messageCount} (${checkpoint.fromTs} to ${checkpoint.toTs})\n\n` +
          `## Summary\n\n${checkpoint.summary}\n`,
      );

      const indexPath = join(checkpointsDir, "index.json");
      let index: SummaryCheckpoint[] = [];
      if (existsSync(indexPath)) {
        try {
          index = JSON.parse(readFileSync(indexPath, "utf-8"));
        } catch {}
      }
      index.push(checkpoint);
      writeFileSync(indexPath, JSON.stringify(index, null, 2));
    } catch (err) {
      // Log but don't throw - checkpoint is safely stored in-memory
      console.error("[Summarizer] Failed to write checkpoint to disk:", err);
    }
  }

  /**
   * Generate a summary of the conversation using LLM sidecar agent
   */
  private async generateSummary(conversationText: string, messageCount: number): Promise<string> {
    try {
      const summary = await this.callLLMSidecar(conversationText, messageCount);
      if (summary) return summary;
    } catch (err) {
      console.error("[Summarizer] LLM sidecar failed, using fallback:", err);
    }

    return this.generateFallbackSummary(conversationText, messageCount);
  }

  /**
   * Call Copilot CLI as a sidecar agent for intelligent summarization
   */
  private async callLLMSidecar(conversationText: string, messageCount: number): Promise<string | null> {
    const { CopilotClient } = await import("../api/client");

    if (!this.config.token) {
      console.log("[Summarizer] No token provided, using fallback summary");
      return null;
    }

    const maxChars = 24000;
    const truncatedText =
      conversationText.length > maxChars
        ? `${conversationText.substring(0, maxChars)}\n\n[...truncated...]`
        : conversationText;

    const prompt = `You are a conversation summarizer. Summarize the following ${messageCount} messages from a chat conversation.

Focus on:
1. Key decisions made
2. Technical work completed (files modified, features implemented)
3. Outstanding tasks or issues mentioned
4. Important context that should be remembered

Be concise but comprehensive. Use bullet points. Output ONLY the summary, no preamble.

---
CONVERSATION:
${truncatedText}
---

Summary:`;

    try {
      // Call our chat/completions API with provided token
      const client = new CopilotClient(this.config.token);
      const response = await client.complete({
        model: this.config.model || "claude-sonnet-4.5",
        messages: [{ role: "user", content: prompt }],
        temperature: 0.3,
        max_tokens: 2000,
      });

      client.close();

      const result = response.choices[0]?.message?.content;

      if (result && result.trim().length > 50) {
        console.log("[Summarizer] LLM summary generated successfully");
        return result.trim();
      }
    } catch (err: any) {
      const errMsg = err?.message || String(err);
      if (errMsg.includes("forbidden") || errMsg.includes("403")) {
        console.log("[Summarizer] Token lacks Copilot API access, using fallback");
      } else {
        console.log("[Summarizer] LLM unavailable, using fallback:", errMsg.substring(0, 100));
      }
    }

    return null;
  }

  /**
   * Fallback summary generation using simple heuristics
   */
  private generateFallbackSummary(conversationText: string, messageCount: number): string {
    // Extract key topics (simple heuristic: look for common patterns)
    const topics: string[] = [];

    // Check for code-related discussions
    if (
      conversationText.includes("```") ||
      conversationText.includes("function") ||
      conversationText.includes("const ")
    ) {
      topics.push("Code implementation and debugging");
    }

    // Check for file operations
    if (conversationText.includes(".ts") || conversationText.includes(".js") || conversationText.includes("file")) {
      topics.push("File modifications");
    }

    // Check for UI discussions
    if (
      conversationText.includes("UI") ||
      conversationText.includes("component") ||
      conversationText.includes("display")
    ) {
      topics.push("UI/UX discussions");
    }

    // Check for architecture discussions
    if (
      conversationText.includes("architecture") ||
      conversationText.includes("design") ||
      conversationText.includes("system")
    ) {
      topics.push("Architecture and design decisions");
    }

    // Check for bug fixes
    if (conversationText.includes("fix") || conversationText.includes("bug") || conversationText.includes("error")) {
      topics.push("Bug fixes and troubleshooting");
    }

    let summary = `This checkpoint covers ${messageCount} messages in the conversation.\n\n`;

    if (topics.length > 0) {
      summary += `**Key Topics:**\n${topics.map((t) => `- ${t}`).join("\n")}\n\n`;
    }

    const lines = conversationText.split("\n\n");
    if (lines.length > 0) {
      const firstMsg = lines[0].substring(0, 200);
      const lastMsg = lines[lines.length - 1].substring(0, 200);
      summary += `**Started with:** "${firstMsg}..."\n\n`;
      summary += `**Ended with:** "${lastMsg}..."\n`;
    }

    return summary;
  }

  /**
   * Get all checkpoints for context loading (in-memory only by default, Option C)
   */
  getAllCheckpoints(): SummaryCheckpoint[] {
    if (!this.config.checkpointFilePath) {
      return [...this.checkpoints];
    }

    const sessionDir = this.fileSession.getSessionDir();
    if (!sessionDir) return [];

    const indexPath = join(sessionDir, "checkpoints", "index.json");
    if (!existsSync(indexPath)) return [];

    try {
      return JSON.parse(readFileSync(indexPath, "utf-8"));
    } catch {
      return [];
    }
  }

  /**
   * Get summarized context for LLM (combines all checkpoint summaries)
   */
  getSummarizedContext(): string {
    const checkpoints = this.getAllCheckpoints();
    if (checkpoints.length === 0) return "";

    return checkpoints.map((cp) => `[History from ${cp.fromTs} to ${cp.toTs}]\n${cp.summary}`).join("\n\n---\n\n");
  }
}

/**
 * Start summarizer as a detached background process
 */
export function startSummarizerSidecar(config: { channel: string; agentId: string; serverUrl: string }): void {
  const scriptPath = join(__dirname, "summarizer-worker.ts");

  if (!existsSync(scriptPath)) {
    createSummarizerWorkerScript(scriptPath);
  }

  const child = spawn(
    "bun",
    ["run", scriptPath, "--channel", config.channel, "--agent", config.agentId, "--server", config.serverUrl],
    {
      detached: true,
      stdio: "ignore",
    },
  );

  child.unref();
  console.log(`[Summarizer] Started sidecar process (PID: ${child.pid})`);
}

function createSummarizerWorkerScript(path: string): void {
  const script = `#!/usr/bin/env bun
/**
 * Summarizer Worker - Runs as background sidecar
 */
import { SessionSummarizer } from './summarizer';
import { parseArgs } from 'node:util';

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    channel: { type: 'string' },
    agent: { type: 'string' },
    server: { type: 'string' },
  },
});

const channel = values.channel || 'default';
const agentId = values.agent || 'default';
const serverUrl = values.server || 'http://localhost:3001';

const summarizer = new SessionSummarizer({
  channel,
  agentId,
  serverUrl,
  messageThreshold: 50,
  keepRecentCount: 20,
  checkInterval: 60000,
});

summarizer.start();

// Keep process alive
process.on('SIGINT', () => {
  summarizer.stop();
  process.exit(0);
});

process.on('SIGTERM', () => {
  summarizer.stop();
  process.exit(0);
});
`;
  writeFileSync(path, script);
}
