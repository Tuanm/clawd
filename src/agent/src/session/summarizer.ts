/**
 * Summarization Sidecar Agent
 *
 * Runs in background to periodically compact old messages into summaries.
 * Uses the database as source of truth and updates session files.
 */

import { spawn } from "node:child_process";
import { join } from "node:path";
import { existsSync, writeFileSync, readFileSync, mkdirSync } from "node:fs";
import { FileSessionManager } from "./file-manager";

// ============================================================================
// Types
// ============================================================================

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
}

export interface SummaryCheckpoint {
  id: string;
  createdAt: string;
  fromTs: string;
  toTs: string;
  messageCount: number;
  summary: string;
}

// ============================================================================
// Summarizer Class
// ============================================================================

export class SessionSummarizer {
  private config: SummarizerConfig;
  private fileSession: FileSessionManager;
  private intervalId?: NodeJS.Timeout;
  private isRunning = false;

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
      checkInterval: 60000, // Check every 60 seconds
      ...config,
    };
    this.fileSession = new FileSessionManager(this.config.channel, this.config.agentId);
  }

  /**
   * Start the background summarization loop
   */
  start(): void {
    if (this.isRunning) return;
    this.isRunning = true;

    console.log(`[Summarizer] Started for ${this.config.channel}/${this.config.agentId}`);
    console.log(`[Summarizer] Threshold: ${this.config.messageThreshold}, Keep recent: ${this.config.keepRecentCount}`);

    // Run immediately, then on interval
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
   */
  async checkAndSummarize(): Promise<void> {
    try {
      // Fetch current message count from DB
      const messages = await this.fetchDbMessages();

      if (messages.length < this.config.messageThreshold) {
        return; // Not enough messages to warrant summarization
      }

      // Get existing checkpoints to see what's already summarized
      const lastCheckpoint = this.getLastCheckpoint();
      const lastSummarizedTs = lastCheckpoint?.toTs || "0";

      // Filter to messages that haven't been summarized
      const unsummarizedMessages = messages.filter((m) => m.ts > lastSummarizedTs);

      if (unsummarizedMessages.length < this.config.messageThreshold - this.config.keepRecentCount) {
        return; // Not enough new messages
      }

      console.log(`[Summarizer] ${unsummarizedMessages.length} unsummarized messages, running summarization...`);

      // Keep the most recent messages, summarize the rest
      const messagesToSummarize = unsummarizedMessages.slice(0, -this.config.keepRecentCount);

      if (messagesToSummarize.length < 10) {
        return; // Need at least 10 messages to make a meaningful summary
      }

      await this.createSummary(messagesToSummarize);
    } catch (err) {
      console.error("[Summarizer] Error:", err);
    }
  }

  /**
   * Fetch messages from the database
   */
  private async fetchDbMessages(): Promise<any[]> {
    try {
      const response = await fetch(`${this.config.serverUrl}/api/conversations.history`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          channel: this.config.channel,
          limit: 500, // Fetch more for summarization
        }),
      });

      if (response.ok) {
        const data = (await response.json()) as {
          ok: boolean;
          messages: any[];
        };
        if (data.ok && data.messages) {
          // Sort by timestamp (oldest first for summarization)
          return data.messages.sort((a, b) => parseFloat(a.ts) - parseFloat(b.ts));
        }
      }
    } catch (err) {
      console.error("[Summarizer] Failed to fetch DB messages:", err);
    }
    return [];
  }

  /**
   * Get the most recent checkpoint
   */
  private getLastCheckpoint(): SummaryCheckpoint | null {
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
   * Create a summary checkpoint from messages
   */
  private async createSummary(messages: any[]): Promise<void> {
    const sessionDir = this.fileSession.getSessionDir();
    if (!sessionDir) {
      // Initialize session first
      this.fileSession.getOrCreateSession("summarizer");
    }

    const dir = this.fileSession.getSessionDir()!;
    const checkpointsDir = join(dir, "checkpoints");
    mkdirSync(checkpointsDir, { recursive: true });

    // Format messages for summarization
    const conversationText = messages
      .map((m) => {
        const role = m.user === "UHUMAN" ? "Human" : m.agent_id || "Bot";
        return `[${role}]: ${m.text}`;
      })
      .join("\n\n");

    // Generate summary using LLM (via copilot API or simple heuristic)
    const summary = await this.generateSummary(conversationText, messages.length);

    // Create checkpoint
    const checkpoint: SummaryCheckpoint = {
      id: `checkpoint-${Date.now()}`,
      createdAt: new Date().toISOString(),
      fromTs: messages[0].ts,
      toTs: messages[messages.length - 1].ts,
      messageCount: messages.length,
      summary,
    };

    // Save checkpoint content
    const checkpointPath = join(checkpointsDir, `${checkpoint.id}.md`);
    writeFileSync(
      checkpointPath,
      `# Checkpoint: ${checkpoint.id}\n\n` +
        `**Created:** ${checkpoint.createdAt}\n` +
        `**Messages:** ${checkpoint.messageCount} (${checkpoint.fromTs} to ${checkpoint.toTs})\n\n` +
        `## Summary\n\n${summary}\n`,
    );

    // Update index
    const indexPath = join(checkpointsDir, "index.json");
    let index: SummaryCheckpoint[] = [];
    if (existsSync(indexPath)) {
      try {
        index = JSON.parse(readFileSync(indexPath, "utf-8"));
      } catch {}
    }
    index.push(checkpoint);
    writeFileSync(indexPath, JSON.stringify(index, null, 2));

    // Log event
    this.fileSession.appendEvent({
      type: "summary.created",
      data: {
        checkpointId: checkpoint.id,
        messageCount: checkpoint.messageCount,
        fromTs: checkpoint.fromTs,
        toTs: checkpoint.toTs,
      },
    });

    console.log(`[Summarizer] Created checkpoint: ${checkpoint.id} (${checkpoint.messageCount} messages)`);
  }

  /**
   * Generate a summary of the conversation using LLM sidecar agent
   */
  private async generateSummary(conversationText: string, messageCount: number): Promise<string> {
    try {
      // Use Copilot CLI as sidecar agent for summarization
      const summary = await this.callLLMSidecar(conversationText, messageCount);
      if (summary) return summary;
    } catch (err) {
      console.error("[Summarizer] LLM sidecar failed, using fallback:", err);
    }

    // Fallback to simple heuristic if LLM fails
    return this.generateFallbackSummary(conversationText, messageCount);
  }

  /**
   * Call Copilot CLI as a sidecar agent for intelligent summarization
   */
  private async callLLMSidecar(conversationText: string, messageCount: number): Promise<string | null> {
    const { CopilotClient } = await import("../api/client");

    // Skip LLM if no token provided
    if (!this.config.token) {
      console.log("[Summarizer] No token provided, using fallback summary");
      return null;
    }

    // Truncate conversation if too long (keep under ~8k tokens)
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
        model: this.config.model || "claude-sonnet-4.5", // Use same model as agent
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
      // Gracefully handle API errors - don't log full stack trace
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

    // Look for code-related discussions
    if (
      conversationText.includes("```") ||
      conversationText.includes("function") ||
      conversationText.includes("const ")
    ) {
      topics.push("Code implementation and debugging");
    }

    // Look for file operations
    if (conversationText.includes(".ts") || conversationText.includes(".js") || conversationText.includes("file")) {
      topics.push("File modifications");
    }

    // Look for UI discussions
    if (
      conversationText.includes("UI") ||
      conversationText.includes("component") ||
      conversationText.includes("display")
    ) {
      topics.push("UI/UX discussions");
    }

    // Look for architecture discussions
    if (
      conversationText.includes("architecture") ||
      conversationText.includes("design") ||
      conversationText.includes("system")
    ) {
      topics.push("Architecture and design decisions");
    }

    // Look for bug fixes
    if (conversationText.includes("fix") || conversationText.includes("bug") || conversationText.includes("error")) {
      topics.push("Bug fixes and troubleshooting");
    }

    // Build summary
    let summary = `This checkpoint covers ${messageCount} messages in the conversation.\n\n`;

    if (topics.length > 0) {
      summary += `**Key Topics:**\n${topics.map((t) => `- ${t}`).join("\n")}\n\n`;
    }

    // Add first and last message excerpts
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
   * Get all checkpoints for context loading
   */
  getAllCheckpoints(): SummaryCheckpoint[] {
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

// ============================================================================
// Standalone Sidecar Runner
// ============================================================================

/**
 * Start summarizer as a detached background process
 */
export function startSummarizerSidecar(config: { channel: string; agentId: string; serverUrl: string }): void {
  const scriptPath = join(__dirname, "summarizer-worker.ts");

  // Check if worker script exists, create if not
  if (!existsSync(scriptPath)) {
    createSummarizerWorkerScript(scriptPath);
  }

  const child = spawn("bun", ["run", scriptPath], {
    detached: true,
    stdio: "ignore",
    env: {
      ...process.env,
      SUMMARIZER_CHANNEL: config.channel,
      SUMMARIZER_AGENT: config.agentId,
      SUMMARIZER_SERVER: config.serverUrl,
    },
  });

  child.unref();
  console.log(`[Summarizer] Started sidecar process (PID: ${child.pid})`);
}

function createSummarizerWorkerScript(path: string): void {
  const script = `#!/usr/bin/env bun
/**
 * Summarizer Worker - Runs as background sidecar
 */
import { SessionSummarizer } from './summarizer';

const channel = process.env.SUMMARIZER_CHANNEL || 'default';
const agentId = process.env.SUMMARIZER_AGENT || 'default';
const serverUrl = process.env.SUMMARIZER_SERVER || 'http://localhost:3001';

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
