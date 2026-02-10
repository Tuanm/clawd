/**
 * Checkpoint Manager
 *
 * Creates structured markdown checkpoints that preserve semantic context
 * across session compaction. Similar to Copilot CLI's checkpoint system.
 */

import { mkdirSync, existsSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { CopilotClient, type Message } from "../api/client";

// ============================================================================
// Types
// ============================================================================

export interface Checkpoint {
  number: number;
  title: string;
  createdAt: string;
  overview: string;
  history: string[];
  workDone: string[];
  technicalDetails: string;
  importantFiles: Array<{ path: string; description: string }>;
  nextSteps: string;
}

export interface CheckpointIndex {
  sessionId: string;
  checkpoints: Array<{
    number: number;
    title: string;
    filename: string;
    createdAt: string;
  }>;
  lastUpdated: string;
}

export interface CheckpointConfig {
  sessionId: string;
  sessionDir: string;
  token?: string;
  model?: string;
}

// ============================================================================
// Checkpoint Manager
// ============================================================================

export class CheckpointManager {
  private config: CheckpointConfig;
  private checkpointsDir: string;
  private indexPath: string;
  private client: CopilotClient | null = null;

  constructor(config: CheckpointConfig) {
    this.config = config;
    this.checkpointsDir = join(config.sessionDir, "checkpoints");
    this.indexPath = join(this.checkpointsDir, "index.json");

    // Initialize LLM client if token provided
    if (config.token) {
      this.client = new CopilotClient(config.token);
    }

    // Ensure checkpoints directory exists
    if (!existsSync(this.checkpointsDir)) {
      mkdirSync(this.checkpointsDir, { recursive: true });
    }
  }

  // --------------------------------------------------------------------------
  // Create Checkpoint
  // --------------------------------------------------------------------------

  async createCheckpoint(messages: Message[], previousCheckpoint?: Checkpoint): Promise<Checkpoint> {
    const index = this.loadIndex();
    const number = index.checkpoints.length + 1;

    // Generate checkpoint content using LLM or fallback
    let checkpoint: Checkpoint;

    if (this.client) {
      checkpoint = await this.generateCheckpointWithLLM(messages, number, previousCheckpoint);
    } else {
      checkpoint = this.generateCheckpointFallback(messages, number, previousCheckpoint);
    }

    // Save checkpoint file
    const filename = this.formatFilename(number, checkpoint.title);
    const content = this.formatCheckpointMarkdown(checkpoint);
    writeFileSync(join(this.checkpointsDir, filename), content);

    // Update index
    index.checkpoints.push({
      number,
      title: checkpoint.title,
      filename,
      createdAt: checkpoint.createdAt,
    });
    index.lastUpdated = new Date().toISOString();
    this.saveIndex(index);

    return checkpoint;
  }

  // --------------------------------------------------------------------------
  // LLM-Based Checkpoint Generation
  // --------------------------------------------------------------------------

  private async generateCheckpointWithLLM(
    messages: Message[],
    number: number,
    previousCheckpoint?: Checkpoint,
  ): Promise<Checkpoint> {
    const systemPrompt = `You are a session summarizer. Create a structured checkpoint summary of the conversation.

Output ONLY valid JSON with this exact structure:
{
  "title": "3-5 word title describing main work",
  "overview": "1-2 sentence overview of what's happening",
  "history": ["First major action", "Second major action", ...],
  "workDone": ["[x] Completed task 1", "[x] Completed task 2", "[ ] Pending task"],
  "technicalDetails": "Key facts, decisions, architecture choices to preserve",
  "importantFiles": [{"path": "/path/to/file", "description": "why it matters"}],
  "nextSteps": "What should happen next"
}

Focus on:
- Key decisions and their rationale
- Technical details that would be lost if messages are deleted
- Files that were created/modified
- What was accomplished vs what's pending`;

    const previousContext = previousCheckpoint
      ? `\n\nPrevious checkpoint context:\n${previousCheckpoint.overview}\nHistory: ${previousCheckpoint.history.join(", ")}`
      : "";

    const conversationSummary = this.summarizeMessagesForPrompt(messages);

    try {
      const response = await this.client!.complete({
        model: this.config.model || "claude-sonnet-4.5",
        messages: [
          { role: "system", content: systemPrompt },
          {
            role: "user",
            content: `Create a checkpoint summary for this conversation:${previousContext}\n\n${conversationSummary}`,
          },
        ],
        temperature: 0.3,
        max_tokens: 2000,
      });

      const content = response.choices[0]?.message?.content || "";
      const jsonMatch = content.match(/\{[\s\S]*\}/);

      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        return {
          number,
          createdAt: new Date().toISOString(),
          title: parsed.title || `Checkpoint ${number}`,
          overview: parsed.overview || "",
          history: parsed.history || [],
          workDone: parsed.workDone || [],
          technicalDetails: parsed.technicalDetails || "",
          importantFiles: parsed.importantFiles || [],
          nextSteps: parsed.nextSteps || "",
        };
      }
    } catch (err) {
      console.error("[Checkpoint] LLM generation failed, using fallback:", err);
    }

    // Fallback if LLM fails
    return this.generateCheckpointFallback(messages, number, previousCheckpoint);
  }

  // --------------------------------------------------------------------------
  // Fallback Checkpoint Generation (Heuristics)
  // --------------------------------------------------------------------------

  private generateCheckpointFallback(messages: Message[], number: number, previousCheckpoint?: Checkpoint): Checkpoint {
    const userMessages = messages.filter((m) => m.role === "user");
    const assistantMessages = messages.filter((m) => m.role === "assistant");

    // Extract potential file paths from messages
    const filePatterns = /(?:\/[\w.-]+)+\.\w+/g;
    const importantFiles: Array<{ path: string; description: string }> = [];
    const seenFiles = new Set<string>();

    for (const msg of messages) {
      const content = typeof msg.content === "string" ? msg.content : "";
      const matches = content.match(filePatterns) || [];
      for (const path of matches.slice(0, 10)) {
        if (!seenFiles.has(path)) {
          seenFiles.add(path);
          importantFiles.push({ path, description: "Referenced in conversation" });
        }
      }
    }

    // Build history from user messages
    const history = userMessages.slice(0, 10).map((m) => {
      const content = typeof m.content === "string" ? m.content : "";
      return content.slice(0, 100) + (content.length > 100 ? "..." : "");
    });

    // Extract title from first user message
    const firstUserContent = userMessages[0]?.content;
    const firstUserText = typeof firstUserContent === "string" ? firstUserContent : "";
    const title =
      firstUserText
        .slice(0, 50)
        .replace(/[^a-zA-Z0-9\s]/g, "")
        .trim() || `Checkpoint ${number}`;

    // Build technical details from tool calls
    const toolCalls: string[] = [];
    for (const msg of assistantMessages) {
      if (msg.tool_calls) {
        for (const tc of msg.tool_calls) {
          toolCalls.push(`- ${tc.function.name}`);
        }
      }
    }

    return {
      number,
      createdAt: new Date().toISOString(),
      title: title.split(" ").slice(0, 5).join(" "),
      overview: `Session with ${messages.length} messages, ${userMessages.length} user turns.`,
      history: history.slice(0, 5),
      workDone: [`[x] Processed ${userMessages.length} requests`],
      technicalDetails:
        toolCalls.length > 0
          ? `Tools used:\n${[...new Set(toolCalls)].slice(0, 20).join("\n")}`
          : "No tool calls recorded.",
      importantFiles: importantFiles.slice(0, 10),
      nextSteps: previousCheckpoint?.nextSteps || "Continue with user requests.",
    };
  }

  // --------------------------------------------------------------------------
  // Format Helpers
  // --------------------------------------------------------------------------

  private formatFilename(number: number, title: string): string {
    const paddedNum = String(number).padStart(3, "0");
    const slug = title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 40);
    return `${paddedNum}-${slug}.md`;
  }

  private formatCheckpointMarkdown(checkpoint: Checkpoint): string {
    const importantFilesStr = checkpoint.importantFiles.map((f) => `- \`${f.path}\` - ${f.description}`).join("\n");

    return `# Checkpoint ${checkpoint.number} - ${checkpoint.title}

Created: ${checkpoint.createdAt}

<overview>
${checkpoint.overview}
</overview>

<history>
${checkpoint.history.map((h, i) => `${i + 1}. ${h}`).join("\n")}
</history>

<work_done>
${checkpoint.workDone.join("\n")}
</work_done>

<technical_details>
${checkpoint.technicalDetails}
</technical_details>

<important_files>
${importantFilesStr || "None recorded."}
</important_files>

<next_steps>
${checkpoint.nextSteps}
</next_steps>
`;
  }

  private summarizeMessagesForPrompt(messages: Message[]): string {
    const lines: string[] = [];

    for (const msg of messages.slice(-50)) {
      // Last 50 messages
      const role = msg.role.toUpperCase();
      const content = typeof msg.content === "string" ? msg.content : "";
      const truncated = content.slice(0, 500) + (content.length > 500 ? "..." : "");

      if (msg.tool_calls) {
        const tools = msg.tool_calls.map((tc) => tc.function.name).join(", ");
        lines.push(`[${role}] Called tools: ${tools}`);
      } else if (content) {
        lines.push(`[${role}] ${truncated}`);
      }
    }

    return lines.join("\n\n");
  }

  // --------------------------------------------------------------------------
  // Load/Save Index
  // --------------------------------------------------------------------------

  private loadIndex(): CheckpointIndex {
    if (existsSync(this.indexPath)) {
      try {
        return JSON.parse(readFileSync(this.indexPath, "utf-8"));
      } catch {
        // Corrupted index, rebuild
      }
    }

    return {
      sessionId: this.config.sessionId,
      checkpoints: [],
      lastUpdated: new Date().toISOString(),
    };
  }

  private saveIndex(index: CheckpointIndex): void {
    writeFileSync(this.indexPath, JSON.stringify(index, null, 2));
  }

  // --------------------------------------------------------------------------
  // Load Checkpoint
  // --------------------------------------------------------------------------

  loadLatestCheckpoint(): Checkpoint | null {
    const index = this.loadIndex();
    if (index.checkpoints.length === 0) return null;

    const latest = index.checkpoints[index.checkpoints.length - 1];
    return this.loadCheckpoint(latest.filename);
  }

  loadCheckpoint(filename: string): Checkpoint | null {
    const filepath = join(this.checkpointsDir, filename);
    if (!existsSync(filepath)) return null;

    const content = readFileSync(filepath, "utf-8");
    return this.parseCheckpointMarkdown(content);
  }

  private parseCheckpointMarkdown(content: string): Checkpoint {
    const extractSection = (tag: string): string => {
      const regex = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, "i");
      const match = content.match(regex);
      return match ? match[1].trim() : "";
    };

    // Parse header for number and title
    const headerMatch = content.match(/^#\s*Checkpoint\s*(\d+)\s*-\s*(.+)$/m);
    const number = headerMatch ? parseInt(headerMatch[1], 10) : 0;
    const title = headerMatch ? headerMatch[2].trim() : "Unknown";

    // Parse created date
    const createdMatch = content.match(/Created:\s*(.+)$/m);
    const createdAt = createdMatch ? createdMatch[1].trim() : new Date().toISOString();

    // Parse history (numbered list)
    const historyText = extractSection("history");
    const history = historyText
      .split("\n")
      .map((line) => line.replace(/^\d+\.\s*/, "").trim())
      .filter(Boolean);

    // Parse work_done (checkbox list)
    const workDoneText = extractSection("work_done");
    const workDone = workDoneText
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.startsWith("[") || line.startsWith("-"));

    // Parse important_files
    const filesText = extractSection("important_files");
    const importantFiles: Array<{ path: string; description: string }> = [];
    for (const line of filesText.split("\n")) {
      const match = line.match(/^-\s*`([^`]+)`\s*-\s*(.+)$/);
      if (match) {
        importantFiles.push({ path: match[1], description: match[2] });
      }
    }

    return {
      number,
      title,
      createdAt,
      overview: extractSection("overview"),
      history,
      workDone,
      technicalDetails: extractSection("technical_details"),
      importantFiles,
      nextSteps: extractSection("next_steps"),
    };
  }

  // --------------------------------------------------------------------------
  // List Checkpoints
  // --------------------------------------------------------------------------

  listCheckpoints(): CheckpointIndex["checkpoints"] {
    return this.loadIndex().checkpoints;
  }

  getCheckpointCount(): number {
    return this.loadIndex().checkpoints.length;
  }

  // --------------------------------------------------------------------------
  // Format for Context Injection
  // --------------------------------------------------------------------------

  formatForContext(checkpoint: Checkpoint): string {
    return `<session_checkpoint number="${checkpoint.number}">
<overview>${checkpoint.overview}</overview>
<history>
${checkpoint.history.map((h, i) => `${i + 1}. ${h}`).join("\n")}
</history>
<technical_details>
${checkpoint.technicalDetails}
</technical_details>
<important_files>
${checkpoint.importantFiles.map((f) => `- ${f.path}: ${f.description}`).join("\n")}
</important_files>
<next_steps>${checkpoint.nextSteps}</next_steps>
</session_checkpoint>`;
  }
}
