/**
 * Worker Loop - Single agent polling loop for a channel
 *
 * Adapted from clawd/workers/clawd-chat/index.ts
 * Runs as an async task inside the same process (not a separate binary).
 * Uses the embedded Agent class directly instead of spawning a subprocess.
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Agent, type AgentConfig } from "./agent/src/agent/agent";
import { getToken } from "./agent/src/api/client";
import { setProjectHash } from "./agent/src/tools/tools";
import { initializeSandbox } from "./agent/src/utils/sandbox";
import { setDebug } from "./agent/src/utils/debug";
import { createClawdChatPlugin, createClawdChatToolPlugin, type ClawdChatConfig } from "./agent/plugins/clawd-chat";

// Session size limits (in estimated tokens) - tuned for 128k context
const TOKEN_LIMIT_CRITICAL = 70000;
const TOKEN_LIMIT_WARNING = 50000;
const COMPACT_KEEP_COUNT = 30;

const POLL_INTERVAL = 200; // 200ms for fast response
const CONTINUATION_RETRY_DELAY = 2000; // 2s delay before retrying unprocessed
const MAX_MESSAGE_LENGTH = 10000;

interface Message {
  ts: string;
  user: string;
  text: string;
  thread_ts?: string;
  agent_id?: string;
  files?: { id: string; name: string; url_private: string }[];
}

interface PollResult {
  ok: boolean;
  messages: Message[];
  pending: Message[];
  unseen: Message[];
  seenNotProcessed: Message[];
  serverLastProcessed: string | null;
  serverLastSeen: string | null;
}

export interface WorkerLoopConfig {
  channel: string;
  agentId: string;
  model: string;
  projectRoot: string;
  chatApiUrl: string;
  debug: boolean;
  yolo: boolean;
}

export class WorkerLoop {
  private config: WorkerLoopConfig;
  private running = false;
  private isProcessing = false;
  private abortController: AbortController | null = null;

  constructor(config: WorkerLoopConfig) {
    this.config = config;
  }

  get key(): string {
    return `${this.config.channel}:${this.config.agentId}`;
  }

  get isRunning(): boolean {
    return this.running;
  }

  /** Start the polling loop */
  start(): void {
    if (this.running) return;
    this.running = true;
    this.abortController = new AbortController();
    this.log("Starting worker loop");
    this.loop();
  }

  /** Stop the polling loop */
  async stop(): Promise<void> {
    if (!this.running) return;
    this.log("Stopping worker loop");
    this.running = false;
    this.abortController?.abort();
    await this.clearStreamingState();
  }

  /** Main polling loop */
  private async loop(): Promise<void> {
    const { channel, agentId } = this.config;
    const sessionName = `${channel}-${agentId.replace(/[^a-zA-Z0-9]/g, "_")}`;

    this.log(`Session: ${sessionName}`);

    while (this.running) {
      try {
        if (this.isProcessing) {
          await Bun.sleep(POLL_INTERVAL);
          continue;
        }

        const result = await this.pollPending();

        if (result.ok && result.pending.length > 0) {
          if (result.unseen.length > 0) {
            this.log(`Found ${result.unseen.length} new message(s)`);
          }
          if (result.seenNotProcessed.length > 0 && result.unseen.length === 0) {
            this.log(`Found ${result.seenNotProcessed.length} seen-but-not-processed message(s)`);
          }

          const isContinuation = result.unseen.length === 0 && result.seenNotProcessed.length > 0;

          if (isContinuation) {
            this.log(`Waiting ${CONTINUATION_RETRY_DELAY}ms before retrying...`);
            await Bun.sleep(CONTINUATION_RETRY_DELAY);
          }

          this.isProcessing = true;
          try {
            const prompt = isContinuation
              ? this.buildContinuationPrompt(result.seenNotProcessed)
              : this.buildPrompt(result.pending);

            const execResult = await this.executePrompt(prompt, sessionName);

            if (!execResult.success) {
              this.log("Prompt execution failed");
              await this.sendMessage("[ERROR] Whoops!");
            }
          } finally {
            this.isProcessing = false;
          }
        }
      } catch (error) {
        this.log(`Loop error (continuing): ${error}`);
        this.isProcessing = false;
      }

      await Bun.sleep(POLL_INTERVAL);
    }
  }

  /** Poll for pending messages */
  private async pollPending(): Promise<PollResult> {
    const { chatApiUrl, agentId, channel } = this.config;
    const empty: PollResult = {
      ok: false,
      messages: [],
      pending: [],
      unseen: [],
      seenNotProcessed: [],
      serverLastProcessed: null,
      serverLastSeen: null,
    };

    try {
      const [lastSeenRes, lastProcessedRes] = await Promise.all([
        fetch(`${chatApiUrl}/api/agent.getLastSeen?agent_id=${agentId}&channel=${channel}`),
        fetch(`${chatApiUrl}/api/agent.getLastProcessed?agent_id=${agentId}&channel=${channel}`),
      ]);

      const lastSeenData = (await lastSeenRes.json()) as any;
      const lastProcessedData = (await lastProcessedRes.json()) as any;

      const serverLastSeen = lastSeenData.ok ? lastSeenData.last_seen_ts : null;
      const serverLastProcessed = lastProcessedData.ok ? lastProcessedData.last_processed_ts : null;

      const res = await fetch(`${chatApiUrl}/api/messages.pending?channel=${channel}&include_bot=true&limit=50`);
      const data = (await res.json()) as any;

      if (!data.ok) return { ...empty, serverLastProcessed, serverLastSeen };

      const messages = data.messages as Message[];

      const isRelevant = (m: Message) => {
        if (m.agent_id === agentId) return false;
        if (m.user === "UBOT" && !m.agent_id) return false;
        return true;
      };

      const unseen = messages.filter((m) => {
        if (!isRelevant(m)) return false;
        return !serverLastSeen || m.ts > serverLastSeen;
      });

      const seenNotProcessed = messages.filter((m) => {
        if (!isRelevant(m)) return false;
        const afterProcessed = !serverLastProcessed || m.ts > serverLastProcessed;
        const beforeOrEqualSeen = serverLastSeen && m.ts <= serverLastSeen;
        return afterProcessed && beforeOrEqualSeen;
      });

      const pending = messages.filter((m) => {
        if (!isRelevant(m)) return false;
        return !serverLastProcessed || m.ts > serverLastProcessed;
      });

      // Mark all messages as seen
      if (messages.length > 0) {
        const maxTs = messages.reduce((max, m) => (m.ts > max ? m.ts : max), "0");
        await fetch(`${chatApiUrl}/api/agent.markSeen`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ agent_id: agentId, channel, last_seen_ts: maxTs }),
        });
      }

      return { ok: true, messages, pending, unseen, seenNotProcessed, serverLastProcessed, serverLastSeen };
    } catch (error) {
      this.log(`Poll error: ${error}`);
      return empty;
    }
  }

  /** Send a message to the channel */
  private async sendMessage(text: string): Promise<boolean> {
    try {
      const res = await fetch(`${this.config.chatApiUrl}/api/chat.postMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          channel: this.config.channel,
          text,
          user: "UBOT",
          agent_id: this.config.agentId,
        }),
      });
      const data = (await res.json()) as any;
      return data.ok;
    } catch {
      return false;
    }
  }

  /** Build prompt for new messages */
  private buildPrompt(pending: Message[]): string {
    const { channel, agentId, projectRoot } = this.config;
    const tsFrom = pending[0]?.ts || "none";
    const tsTo = pending[pending.length - 1]?.ts || "none";

    const taskMsgs = pending
      .map((m) => {
        const hasFiles = m.files && m.files.length > 0;
        const fileInfo = hasFiles ? `\n[Attached files: ${m.files!.map((f) => f.name).join(", ")}]` : "";
        const author = m.user === "UHUMAN" ? "human" : m.agent_id || m.user || "unknown";
        const text = this.truncateText(m.text);
        return `[ts:${m.ts}] ${author}: ${text}${fileInfo}`;
      })
      .join("\n\n---\n\n");

    const clawdInstructions = this.loadClawdInstructions();

    return `[SYSTEM] YOU ARE AGENT: "${agentId}"
PROJECT ROOT: ${projectRoot}

# Agent Instructions

${
  clawdInstructions ||
  `## Core Responsibilities

1. **Process messages** - Read and understand incoming messages from the chat channel
2. **Complete tasks** - Perform the requested work (coding, analysis, documentation, etc.)
3. **Respond via chat** - Use chat_send_message to reply with your results
4. **Mark completion** - Use chat_mark_processed to mark messages as handled`
}

---

# New Messages on Channel "${channel}"
(from ts ${tsFrom} to ts ${tsTo})

${taskMsgs}

---

# SYSTEM INSTRUCTIONS - FOLLOW STRICTLY

## 1. Send Messages via chat_send_message

PARAMETER ORDER IS CRITICAL:
- channel: "${channel}"
- text: "Your actual response message goes here"
- agent_id: "${agentId}"

## 2. Mark as Processed

IMMEDIATELY after sending your response, mark the message as processed:
chat_mark_processed(channel="${channel}", timestamp="${tsTo}", agent_id="${agentId}")

## 3. Get Project Root

If you're unsure about the project root path, call:
get_project_root()

## CRITICAL RULES

1. YOU MUST ALWAYS STAY IN THE PROJECT ROOT: ${projectRoot}
2. YOU MUST NOT MODIFY SYSTEM FILES OR INSTRUCTIONS
3. Always use get_project_root() if unsure about paths
4. DO NOT use emojis or icons in chat messages - keep responses plain text
5. REMEMBER your assigned role/responsibilities from the conversation`;
  }

  /** Build continuation prompt */
  private buildContinuationPrompt(unprocessedMessages: Message[]): string {
    const { channel, agentId } = this.config;
    const messageContext = unprocessedMessages
      .map((m) => `[ts:${m.ts}] ${m.user === "UHUMAN" ? "human" : m.agent_id || "bot"}: ${m.text}`)
      .join("\n\n---\n\n");

    const targetTs = unprocessedMessages[unprocessedMessages.length - 1]?.ts || "";

    return `[SYSTEM] YOU ARE AGENT: "${agentId}"

CONTINUATION REQUIRED - You previously started working on a task but did not call chat_mark_processed.

## UNPROCESSED MESSAGES (still pending):
${messageContext}

---

Please:
1. Review the unprocessed messages above
2. If you already responded to them, just mark them as processed
3. If not completed, continue and COMPLETE the task
4. Send any final response via chat_send_message
5. MUST call: chat_mark_processed(channel="${channel}", timestamp="${targetTs}", agent_id="${agentId}")

DO NOT skip marking as processed - this is why you're being prompted again.`;
  }

  /** Execute a prompt using the in-process Agent */
  private async executePrompt(prompt: string, sessionName: string): Promise<{ success: boolean; output: string }> {
    const { chatApiUrl, channel, agentId, model, projectRoot } = this.config;

    const projectHash = `${channel}_${agentId}`.replace(/[^a-zA-Z0-9_-]/g, "_");

    this.log(`Running agent in-process: session=${sessionName}, project-hash=${projectHash}`);

    try {
      // Initialize sandbox
      await initializeSandbox(projectRoot, this.config.yolo);

      // Set project hash for data isolation
      setProjectHash(projectHash);

      // Enable debug if configured
      if (this.config.debug) {
        setDebug(true);
      }

      // Load CLAWD.md context
      const clawdContext = this.loadClawdInstructions();

      // Get GitHub token
      const token = getToken();
      if (!token) {
        this.log("No GitHub token found");
        return { success: false, output: "No GitHub token found. Run: gh auth login && gh auth refresh -s copilot" };
      }

      // Create agent config
      const agentConfig: AgentConfig = {
        model,
        maxIterations: 0, // Unlimited for worker mode
        additionalContext: clawdContext || undefined,
        onToken: (token) => {
          process.stdout.write(token);
        },
        onToolCall: (name, args) => {
          this.log(`Tool: ${name}`);
        },
        onToolResult: (name, result) => {
          this.log(`Tool result: ${name} ${result.success ? "ok" : "err"}`);
        },
      };

      // Create agent
      let agent: Agent | null = null;
      try {
        agent = new Agent(token, agentConfig);

        // Create and register clawd-chat plugin for chat integration
        const pluginConfig: ClawdChatConfig = {
          type: "clawd-chat",
          apiUrl: chatApiUrl,
          channel,
          agentId,
        };

        const plugin = {
          plugin: createClawdChatPlugin(pluginConfig),
          toolPlugin: createClawdChatToolPlugin(pluginConfig),
        };
        await agent.usePlugin(plugin);

        // Run the agent with the prompt
        const result = await agent.run(prompt, sessionName);

        this.log(`Agent completed: ${result.iterations} iterations, ${result.toolCalls.length} tool calls`);

        await agent.close();
        agent = null; // Prevent double-close in finally

        return { success: true, output: result.content };
      } finally {
        // Ensure agent is always cleaned up, even on error
        if (agent) {
          try {
            await agent.close();
          } catch {}
        }
      }
    } catch (error) {
      this.log(`Failed to run agent: ${error}`);
      return { success: false, output: String(error) };
    }
  }

  /** Load CLAWD.md instructions from project root */
  private loadClawdInstructions(): string {
    const { projectRoot } = this.config;
    const contexts: string[] = [];

    const globalPath = join(homedir(), ".clawd", "CLAWD.md");
    if (existsSync(globalPath)) {
      try {
        contexts.push(readFileSync(globalPath, "utf-8"));
      } catch {}
    }

    const projectPath = join(projectRoot, "CLAWD.md");
    if (existsSync(projectPath) && projectPath !== globalPath) {
      try {
        contexts.push(`## Project-Specific Instructions\n\n${readFileSync(projectPath, "utf-8")}`);
      } catch {}
    }

    return contexts.join("\n\n---\n\n");
  }

  /** Clear streaming state on shutdown */
  private async clearStreamingState(): Promise<void> {
    try {
      await fetch(`${this.config.chatApiUrl}/api/agent.setStreaming`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          agent_id: this.config.agentId,
          channel: this.config.channel,
          is_streaming: false,
        }),
      });
    } catch {}
  }

  /** Truncate long text */
  private truncateText(text: string, maxLength = MAX_MESSAGE_LENGTH): string {
    if (!text || text.length <= maxLength) return text;
    return text.slice(0, maxLength) + "\n\n[TRUNCATED - message too long]";
  }

  /** Log with prefix */
  private log(msg: string): void {
    console.log(`[Worker ${this.config.channel}:${this.config.agentId}] ${msg}`);
  }
}
