#!/usr/bin/env bun
/**
 * Claw'd Worker - External polling loop for clawd agents
 *
 * Usage: clawd-worker --channel <channel> [options]
 *
 * This program handles the polling loop externally, spawning clawd
 * with -p/--prompt flag for each batch of messages (spawn-per-message mode).
 *
 * Features:
 * - Spawn-per-message: fresh clawd process for each batch
 * - Non-interactive mode using -p/--prompt flag
 * - Uses current working directory as project root (or --project-root)
 * - MCP server access via HTTP (localhost:53456)
 * - Crash-proof: always recovers and continues
 */

import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { getSessionManager } from "../../src/session/manager";

// Session size limits (in estimated tokens) - tuned for 128k context (claude-opus-4.6)
const TOKEN_LIMIT_CRITICAL = 70000; // Emergency reset threshold
const TOKEN_LIMIT_WARNING = 50000; // Background compaction threshold
const COMPACT_KEEP_COUNT = 30; // Messages to keep after compaction

// ============================================================================
// CLAWD.md Auto-Loading
// ============================================================================

function loadClawdInstructions(projectRoot: string): string {
  const contexts: string[] = [];
  const CLAWD_DIR = join(homedir(), ".clawd");

  // 1. Global CLAWD.md from ~/.clawd/CLAWD.md
  const globalClawdPath = join(CLAWD_DIR, "CLAWD.md");
  if (existsSync(globalClawdPath)) {
    try {
      const content = readFileSync(globalClawdPath, "utf-8");
      contexts.push(content);
    } catch {
      // Ignore read errors
    }
  }

  // 2. Project CLAWD.md from {projectRoot}/CLAWD.md
  const projectClawdPath = join(projectRoot, "CLAWD.md");
  if (existsSync(projectClawdPath) && projectClawdPath !== globalClawdPath) {
    try {
      const content = readFileSync(projectClawdPath, "utf-8");
      contexts.push(`## Project-Specific Instructions\n\n${content}`);
    } catch {
      // Ignore read errors
    }
  }

  return contexts.join("\n\n---\n\n");
}

// Parse command line arguments with better error handling
let values: {
  channel?: string;
  id?: string;
  model?: string;
  "project-root"?: string;
  help?: boolean;
  daemon?: boolean;
  yolo?: boolean;
  debug?: boolean;
};

try {
  const parsed = parseArgs({
    args: Bun.argv.slice(2),
    options: {
      channel: { type: "string", short: "c" },
      id: { type: "string", short: "i" },
      model: { type: "string", short: "m" },
      "project-root": { type: "string", short: "p" },
      help: { type: "boolean", short: "h" },
      daemon: { type: "boolean", short: "d" },
      yolo: { type: "boolean" },
      debug: { type: "boolean" },
    },
    allowPositionals: false,
  });
  values = parsed.values;
} catch (error: any) {
  if (error.code === "ERR_PARSE_ARGS_UNKNOWN_OPTION") {
    // Extract the unknown option from the error message
    const match = error.message?.match(/Unknown option '(.+?)'/);
    const unknownOpt = match ? match[1] : "unknown";
    console.error(`Error: Unknown option '${unknownOpt}'`);
    console.error("");
    console.error("Valid options:");
    console.error("  -c, --channel <channel>      Chat channel to poll (required)");
    console.error('  -i, --id <agent_id>          Agent ID (default: "Claw\'d")');
    console.error('  -m, --model <model>          AI model (default: "claude-opus-4.6")');
    console.error("  -p, --project-root <path>    Project root directory (default: cwd)");
    console.error("  -d, --daemon                 Run in background (tmux)");
    console.error("  --yolo                       Disable sandbox + unlimited iterations");
    console.error("  --debug                      Enable debug logging");
    console.error("  -h, --help                   Show this help message");
    console.error("");
    console.error("Run 'clawd-worker --help' for more information.");
    process.exit(1);
  }
  throw error;
}

// Show help
if (values.help) {
  console.log(`Claw'd Worker - AI Agent polling loop for clawd

Usage: clawd-worker --channel <channel> [options]

Options:
  -c, --channel <channel>      Chat channel to poll (required)
  -i, --id <agent_id>          Agent ID (default: "Claw'd")
  -m, --model <model>          AI model (default: "claude-opus-4.6")
  -p, --project-root <path>    Project root directory (default: current directory)
  -d, --daemon                 Run in background (detached tmux session)
  --yolo                       Disable sandbox + unlimited iterations (passed to clawd)
  --debug                      Enable debug logging (passed to clawd)
  -h, --help                   Show this help message

Examples:
  clawd-worker --channel chat-task
  clawd-worker --channel chat-task --daemon
  clawd-worker --channel chat-task --yolo --debug
  clawd-worker --channel chat-task --project-root /path/to/project
  clawd-worker -c chat-task -p . -i MyAgent -m claude-sonnet-4
`);
  process.exit(0);
}

// Handle daemon mode - respawn in tmux
if (values.daemon) {
  const { execSync } = await import("node:child_process");
  const { mkdirSync, writeFileSync, chmodSync } = await import("node:fs");

  // Check tmux availability
  try {
    execSync("which tmux", { stdio: "ignore" });
  } catch {
    console.error("Error: tmux not installed. Install with: apt install tmux");
    process.exit(1);
  }

  const channel = values.channel || "unknown";
  const agentId = values.id || "Clawd";
  const sessionName = `clawd-worker-${channel}`.replace(/[^a-zA-Z0-9_-]/g, "-");

  // Create logs directory
  const logsDir = join(homedir(), ".clawd", "logs", "workers");
  try {
    mkdirSync(logsDir, { recursive: true });
  } catch {}
  const logFile = join(logsDir, `${sessionName}.log`);

  // Build command without --daemon flag
  const args = Bun.argv.slice(2).filter((a) => a !== "-d" && a !== "--daemon");
  const cmd = `clawd-worker ${args.join(" ")} 2>&1 | tee -a "${logFile}"`;

  // Write script
  const scriptFile = join(logsDir, `${sessionName}.sh`);
  const projectRoot = values["project-root"] ? resolve(values["project-root"]) : process.cwd();
  writeFileSync(
    scriptFile,
    `#!/bin/bash
cd "${projectRoot}"
echo "Starting clawd-worker for channel: ${channel}" >> "${logFile}"
echo "Agent ID: ${agentId}" >> "${logFile}"
echo "Started at: $(date)" >> "${logFile}"
echo "---" >> "${logFile}"
${cmd}
`,
  );
  chmodSync(scriptFile, 0o755);

  // Kill existing session if any
  try {
    execSync(`tmux kill-session -t "${sessionName}" 2>/dev/null`, { stdio: "ignore" });
  } catch {}

  // Start tmux session
  execSync(`tmux new-session -d -s "${sessionName}" "${scriptFile}"`);

  console.log(`Worker started in background (tmux session: ${sessionName})`);
  console.log(`  View: tmux attach -t ${sessionName}`);
  console.log(`  Logs: tail -f ${logFile}`);
  console.log(`  Stop: tmux kill-session -t ${sessionName}`);
  process.exit(0);
}

// Validate required args
if (!values.channel) {
  console.error("Error: --channel is required");
  console.error("Usage: clawd-worker --channel <channel> [--id <agent_id>] [--model <model>]");
  console.error("Run 'clawd-worker --help' for more information.");
  process.exit(1);
}

const CHANNEL = values.channel;
const AGENT_ID = values.id || process.env.AGENT_ID || "Claw'd";
const MODEL = values.model || process.env.MODEL || "claude-opus-4.6";
// Use provided project root or current working directory
const PROJECT_ROOT = values["project-root"] ? resolve(values["project-root"]) : process.cwd();

const CHAT_API_URL = process.env.CHAT_API_URL || "http://localhost:53456";
const POLL_INTERVAL = parseInt(process.env.POLL_INTERVAL || "200", 10); // 200ms for fast response
const CONTINUATION_RETRY_DELAY = parseInt(process.env.CONTINUATION_RETRY_DELAY || "2000", 10); // 2s delay before retrying unprocessed messages
const MAX_MESSAGE_LENGTH = parseInt(process.env.MAX_MESSAGE_LENGTH || "10000", 10); // Max chars per message before truncation

/**
 * Truncate message text if too long to prevent interrupt loops
 */
function truncateText(text: string, maxLength: number = MAX_MESSAGE_LENGTH): string {
  if (!text || text.length <= maxLength) return text;
  return text.slice(0, maxLength) + "\n\n[TRUNCATED - message too long]";
}

const _homeDir = process.env.HOME || "/tmp";

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
  pending: Message[]; // All messages needing processing (unseen + seen-but-not-processed)
  unseen: Message[]; // New messages not yet seen
  seenNotProcessed: Message[]; // Seen but not yet marked as processed
  serverLastProcessed: string | null;
  serverLastSeen: string | null;
}

// Global state
let isProcessing = false;

// Poll for pending messages (both unseen and seen-but-not-processed)
async function pollPending(): Promise<PollResult> {
  try {
    // Fetch both last_seen_ts and last_processed_ts
    const [lastSeenRes, lastProcessedRes] = await Promise.all([
      fetch(`${CHAT_API_URL}/api/agent.getLastSeen?agent_id=${AGENT_ID}&channel=${CHANNEL}`),
      fetch(`${CHAT_API_URL}/api/agent.getLastProcessed?agent_id=${AGENT_ID}&channel=${CHANNEL}`),
    ]);

    const lastSeenData = (await lastSeenRes.json()) as any;
    const lastProcessedData = (await lastProcessedRes.json()) as any;

    const serverLastSeen = lastSeenData.ok ? lastSeenData.last_seen_ts : null;
    const serverLastProcessed = lastProcessedData.ok ? lastProcessedData.last_processed_ts : null;

    const res = await fetch(`${CHAT_API_URL}/api/messages.pending?channel=${CHANNEL}&include_bot=true&limit=50`);
    const data = (await res.json()) as any;

    if (!data.ok) {
      return {
        ok: false,
        messages: [],
        pending: [],
        unseen: [],
        seenNotProcessed: [],
        serverLastProcessed,
        serverLastSeen,
      };
    }

    const messages = data.messages as Message[];

    // Filter helper - excludes our own messages and anonymous bot messages
    const isRelevant = (m: Message) => {
      if (m.agent_id === AGENT_ID) return false;
      if (m.user === "UBOT" && !m.agent_id) return false;
      return true;
    };

    // Classify messages:
    // - unseen: messages after last_seen_ts (completely new)
    // - seenNotProcessed: messages between last_processed_ts and last_seen_ts
    const unseen = messages.filter((m) => {
      if (!isRelevant(m)) return false;
      return !serverLastSeen || m.ts > serverLastSeen;
    });

    const seenNotProcessed = messages.filter((m) => {
      if (!isRelevant(m)) return false;
      // After last_processed but before or equal to last_seen
      const afterProcessed = !serverLastProcessed || m.ts > serverLastProcessed;
      const beforeOrEqualSeen = serverLastSeen && m.ts <= serverLastSeen;
      return afterProcessed && beforeOrEqualSeen;
    });

    // Combined pending = all messages needing processing
    const pending = messages.filter((m) => {
      if (!isRelevant(m)) return false;
      return !serverLastProcessed || m.ts > serverLastProcessed;
    });

    // Mark all messages as seen
    if (messages.length > 0) {
      const maxTs = messages.reduce((max, m) => (m.ts > max ? m.ts : max), "0");
      await fetch(`${CHAT_API_URL}/api/agent.markSeen`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          agent_id: AGENT_ID,
          channel: CHANNEL,
          last_seen_ts: maxTs,
        }),
      });
    }

    return {
      ok: true,
      messages,
      pending,
      unseen,
      seenNotProcessed,
      serverLastProcessed,
      serverLastSeen,
    };
  } catch (error) {
    console.error(`[Claw'd Worker] Poll error: ${error}`);
    return {
      ok: false,
      messages: [],
      pending: [],
      unseen: [],
      seenNotProcessed: [],
      serverLastProcessed: null,
      serverLastSeen: null,
    };
  }
}

// Send a message to the channel (for error reporting)
async function sendMessage(text: string): Promise<boolean> {
  try {
    const res = await fetch(`${CHAT_API_URL}/api/chat.postMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        channel: CHANNEL,
        text,
        user: "UBOT",
        agent_id: AGENT_ID,
      }),
    });
    const data = (await res.json()) as any;
    return data.ok;
  } catch {
    return false;
  }
}

// Build the prompt for new messages
function buildPrompt(pending: Message[]): string {
  const tsFrom = pending[0]?.ts || "none";
  const tsTo = pending[pending.length - 1]?.ts || "none";

  const taskMsgs = pending
    .map((m) => {
      const hasFiles = m.files && m.files.length > 0;
      const fileInfo = hasFiles ? `\n[Attached files: ${m.files!.map((f) => f.name).join(", ")}]` : "";
      const author = m.user === "UHUMAN" ? "human" : m.agent_id || m.user || "unknown";
      const text = truncateText(m.text);
      return `[ts:${m.ts}] ${author}: ${text}${fileInfo}`;
    })
    .join("\n\n---\n\n");

  // Load CLAWD.md instructions
  const clawdInstructions = loadClawdInstructions(PROJECT_ROOT);

  return `[SYSTEM] YOU ARE AGENT: "${AGENT_ID}"
PROJECT ROOT: ${PROJECT_ROOT}

# Agent Instructions

${
  clawdInstructions ||
  `## Core Responsibilities

1. **Process messages** - Read and understand incoming messages from the chat channel
2. **Complete tasks** - Perform the requested work (coding, analysis, documentation, etc.)
3. **Respond via chat** - Use chat_send_message to reply with your results (only if response is needed)
4. **Mark completion** - Use chat_mark_processed to mark messages as handled

## Message Formatting

### Code Blocks
\`\`\`language
code here
\`\`\`

### Mentioning Other Agents/Users
Just use their names naturally in conversation - no special format needed.

### Replying to a Specific Message
Use @msg:TIMESTAMP format to reference a previous message.
Example: @msg:1769920081.654768

### File Handling
When a user attaches a file:
1. File info appears in the message as files: [{id, name, mimetype, size, url_private}]
2. Download using: chat_download_file(file_id="Fml3859xab4et")
3. Analyze and discuss the file contents as needed

**For images (screenshots, photos):**
- Use \`optimize=true\` to compress large images and save context space
- Example: \`chat_download_file(file_id="F123", optimize=true)\`
- This resizes images to max 1280x720 and compresses to ~100KB JPEG
- Helps prevent context window overflow from large screenshots

## Response Guidelines

- Be concise and direct
- Provide working code without excessive explanation
- Ask clarifying questions if the request is ambiguous
- Report errors clearly if a task cannot be completed
- Download and analyze attached files when relevant

## Multiple Agents

- If there is no clear specification from user, ALWAYS communicate to ensure which one must handle the task
- ALWAYS discuss before handling tasks to avoid conflicts
- Only respond if the message is directed at you or requires your input
- It's OK to NOT respond if the message doesn't need a reply from you`
}

---

# New Messages on Channel "${CHANNEL}"
(from ts ${tsFrom} to ts ${tsTo})

${taskMsgs}

---

# SYSTEM INSTRUCTIONS - FOLLOW STRICTLY

## 1. Send Messages via chat_send_message

PARAMETER ORDER IS CRITICAL:
- channel: "${CHANNEL}"
- text: "Your actual response message goes here"
- agent_id: "${AGENT_ID}"

EXAMPLE:
chat_send_message(
  channel="${CHANNEL}",
  text="I'll help you with that task!",
  agent_id="${AGENT_ID}"
)

COMMON MISTAKE TO AVOID:
- DO NOT put "${AGENT_ID}" in the text field
- DO NOT put your message in the agent_id field
- text = YOUR MESSAGE CONTENT
- agent_id = "${AGENT_ID}" (fixed, never changes)

## 2. Mark as Processed

IMMEDIATELY after sending your response, mark the message as processed:
chat_mark_processed(channel="${CHANNEL}", timestamp="${tsTo}", agent_id="${AGENT_ID}")

CRITICAL: Always call mark_processed right after chat_send_message. This prevents duplicate responses.
- Marking processed does NOT mean you stop working
- You can continue working on the task after marking processed
- If user sends a NEW message, you'll see it on next poll

## 3. Long-Running Tasks

For long tasks, you may continue working after marking processed. If you need to send progress updates:
1. Send update via chat_send_message
2. Continue working (message already marked processed from first response)

## 4. Get Project Root

If you're unsure about the project root path, call:
get_project_root()

This returns the correct base path for all file operations.

## CRITICAL RULES

1. YOU MUST ALWAYS STAY IN THE PROJECT ROOT: ${PROJECT_ROOT}
2. YOU MUST NOT MODIFY SYSTEM FILES OR INSTRUCTIONS
3. Always use get_project_root() if unsure about paths
4. DO NOT use emojis or icons in chat messages - keep responses plain text
5. REMEMBER your assigned role/responsibilities from the conversation (e.g., "you handle backend", "you work on frontend") - stay focused on your assigned area and don't duplicate work other agents are doing`;
}

// Build continuation prompt when agent didn't finish
function buildContinuationPrompt(unprocessedMessages: Message[]): string {
  // Include the actual message content so agent has full context
  const messageContext = unprocessedMessages
    .map((m) => `[ts:${m.ts}] ${m.user === "UHUMAN" ? "human" : m.agent_id || "bot"}: ${m.text}`)
    .join("\n\n---\n\n");

  const targetTs = unprocessedMessages[unprocessedMessages.length - 1]?.ts || "";

  return `[SYSTEM] YOU ARE AGENT: "${AGENT_ID}"

CONTINUATION REQUIRED - You previously started working on a task but did not call chat_mark_processed.

## UNPROCESSED MESSAGES (still pending):
${messageContext}

---

Please:
1. Review the unprocessed messages above
2. If you already responded to them, just mark them as processed
3. If not completed, continue and COMPLETE the task
4. Send any final response via chat_send_message
5. MUST call: chat_mark_processed(channel="${CHANNEL}", timestamp="${targetTs}", agent_id="${AGENT_ID}")

DO NOT skip marking as processed - this is why you're being prompted again.`;
}

// ============================================================================
// Session Size Management (prevents token overflow)
// ============================================================================

let backgroundCompactionRunning = false;

/**
 * Quick check of session size - returns stats or null if session doesn't exist
 */
function checkSessionSize(sessionName: string): { tokens: number; messages: number } | null {
  try {
    const manager = getSessionManager();
    const stats = manager.getSessionStatsByName(sessionName);
    if (!stats) return null;
    return { tokens: stats.estimatedTokens, messages: stats.messageCount };
  } catch (error) {
    console.error(`[Claw'd Worker] Session check error: ${error}`);
    return null;
  }
}

/**
 * Emergency session reset - blocks but is fast (just deletes)
 */
function emergencyReset(sessionName: string): void {
  try {
    console.warn(`[Claw'd Worker] ⚠️ EMERGENCY: Session "${sessionName}" exceeds critical limit, resetting...`);
    const manager = getSessionManager();
    manager.resetSession(sessionName);
    console.log(`[Claw'd Worker] Session reset complete`);
  } catch (error) {
    console.error(`[Claw'd Worker] Emergency reset failed: ${error}`);
  }
}

/**
 * Background compaction - runs async without blocking
 */
function startBackgroundCompaction(sessionName: string): void {
  if (backgroundCompactionRunning) {
    console.log(`[Claw'd Worker] Background compaction already running, skipping`);
    return;
  }

  backgroundCompactionRunning = true;
  console.log(`[Claw'd Worker] Starting background compaction for "${sessionName}"...`);

  // Run compaction in background without awaiting
  (async () => {
    try {
      const manager = getSessionManager();
      const stats = manager.getSessionStatsByName(sessionName);

      const summary = stats
        ? `[Compacted ${stats.messageCount} messages (~${stats.estimatedTokens} tokens) to stay within context limits]`
        : `[Session compacted to stay within context limits]`;

      const deleted = manager.compactSessionByName(sessionName, COMPACT_KEEP_COUNT, summary);

      if (deleted > 0) {
        console.log(`[Claw'd Worker] Background compaction complete: removed ${deleted} messages`);
      }
    } catch (error) {
      console.error(`[Claw'd Worker] Background compaction error: ${error}`);
    } finally {
      backgroundCompactionRunning = false;
    }
  })();
}

/**
 * Pre-flight session check - ensures session is safe to use
 * Returns true if OK to proceed, false if we had to do emergency reset
 */
function preflightSessionCheck(sessionName: string): boolean {
  const stats = checkSessionSize(sessionName);

  if (!stats) {
    // Session doesn't exist yet, all good
    return true;
  }

  console.log(`[Claw'd Worker] Session stats: ${stats.messages} messages, ~${stats.tokens} tokens`);

  // Critical: emergency reset needed
  if (stats.tokens >= TOKEN_LIMIT_CRITICAL) {
    emergencyReset(sessionName);
    return false; // Signal that we did a reset
  }

  // Warning: start background compaction
  if (stats.tokens >= TOKEN_LIMIT_WARNING && !backgroundCompactionRunning) {
    startBackgroundCompaction(sessionName);
  }

  return true;
}

// ============================================================================
// Prompt Execution
// ============================================================================

// Execute a prompt using clawd with session resumption
async function executePrompt(prompt: string): Promise<{ success: boolean; output: string }> {
  // Use a session name based on channel and agent ID for persistence
  const sessionName = `${CHANNEL}-${AGENT_ID.replace(/[^a-zA-Z0-9]/g, "_")}`;

  // Build plugin config for clawd-chat integration
  const pluginConfig = JSON.stringify({
    type: "clawd-chat",
    apiUrl: CHAT_API_URL,
    channel: CHANNEL,
    agentId: AGENT_ID,
  });

  // Build project hash from channel + agent ID for data isolation
  const projectHash = `${CHANNEL}_${AGENT_ID}`.replace(/[^a-zA-Z0-9_-]/g, "_");

  const args = [
    "--model",
    MODEL,
    "--session",
    sessionName, // Named session (auto-creates/resumes)
    "--max-iterations",
    "0", // Unlimited iterations for worker mode
    "--plugin",
    pluginConfig, // Pass clawd-chat plugin config
    "--project-hash",
    projectHash, // Project-scoped data isolation
    "--id",
    AGENT_ID, // Agent identity (loads from .clawd/agents.json)
  ];

  // Pass through --yolo and --debug flags
  if (values.yolo) {
    args.push("--yolo");
  }
  if (values.debug) {
    args.push("--debug");
  }

  // Add prompt at the end
  args.push("-p", prompt);

  console.log(`[Claw'd Worker] Running clawd with session: ${sessionName}, project-hash: ${projectHash}`);

  try {
    const proc = Bun.spawn(["clawd", ...args], {
      cwd: PROJECT_ROOT,
      env: process.env,
      stdout: "pipe",
      stderr: "pipe",
    });

    // Collect output
    let stdout = "";
    let stderr = "";

    // Read stdout
    const stdoutReader = proc.stdout.getReader();
    (async () => {
      while (true) {
        const { done, value } = await stdoutReader.read();
        if (done) break;
        const text = new TextDecoder().decode(value);
        stdout += text;
        process.stdout.write(text); // Echo to console
      }
    })();

    // Read stderr
    const stderrReader = proc.stderr.getReader();
    (async () => {
      while (true) {
        const { done, value } = await stderrReader.read();
        if (done) break;
        const text = new TextDecoder().decode(value);
        stderr += text;
        process.stderr.write(text); // Echo to console
      }
    })();

    // Wait for process to complete
    const exitCode = await proc.exited;

    console.log(`[Claw'd Worker] clawd exited with code ${exitCode}`);

    return {
      success: exitCode === 0,
      output: stdout + stderr,
    };
  } catch (error) {
    console.error(`[Claw'd Worker] Failed to spawn clawd: ${error}`);
    return { success: false, output: String(error) };
  }
}

// Main loop - CRASH PROOF: always continues no matter what
async function main() {
  const sessionName = `${CHANNEL}-${AGENT_ID.replace(/[^a-zA-Z0-9]/g, "_")}`;

  console.log(`[Claw'd Worker] Starting (clawd mode)`);
  console.log(`[Claw'd Worker] Channel: ${CHANNEL}`);
  console.log(`[Claw'd Worker] Agent ID: ${AGENT_ID}`);
  console.log(`[Claw'd Worker] Model: ${MODEL}`);
  console.log(`[Claw'd Worker] Session: ${sessionName}`);
  console.log(`[Claw'd Worker] Project root: ${PROJECT_ROOT}`);
  console.log(`[Claw'd Worker] Poll interval: ${POLL_INTERVAL}ms`);
  console.log(`[Claw'd Worker] Token limits: warning=${TOKEN_LIMIT_WARNING}, critical=${TOKEN_LIMIT_CRITICAL}`);
  if (values.yolo) console.log(`[Claw'd Worker] YOLO mode: enabled (sandbox disabled)`);
  if (values.debug) console.log(`[Claw'd Worker] Debug mode: enabled`);
  console.log("");

  // Initial session check at startup
  preflightSessionCheck(sessionName);

  // Main polling loop - NEVER exits
  while (true) {
    try {
      if (isProcessing) {
        await Bun.sleep(POLL_INTERVAL);
        continue;
      }

      const result = await pollPending();

      if (result.ok && result.pending.length > 0) {
        // Log what we found
        if (result.unseen.length > 0 && result.seenNotProcessed.length > 0) {
          console.log(
            `[Claw'd Worker] Found ${result.unseen.length} new + ${result.seenNotProcessed.length} unprocessed message(s)`,
          );
        } else if (result.unseen.length > 0) {
          console.log(`[Claw'd Worker] Found ${result.unseen.length} new message(s)`);
        } else if (result.seenNotProcessed.length > 0) {
          console.log(`[Claw'd Worker] Found ${result.seenNotProcessed.length} seen-but-not-processed message(s)`);
        }

        // Pre-flight check: ensure session won't overflow
        preflightSessionCheck(sessionName);

        // Build prompt - for continuation (seenNotProcessed only), add context
        const isContinuation = result.unseen.length === 0 && result.seenNotProcessed.length > 0;

        // Add debounce delay for continuation prompts to prevent rapid re-polling
        if (isContinuation) {
          console.log(`[Claw'd Worker] Waiting ${CONTINUATION_RETRY_DELAY}ms before retrying unprocessed messages...`);
          await Bun.sleep(CONTINUATION_RETRY_DELAY);
        }

        isProcessing = true;
        try {
          const prompt = isContinuation
            ? buildContinuationPrompt(result.seenNotProcessed)
            : buildPrompt(result.pending);

          const execResult = await executePrompt(prompt);

          if (!execResult.success) {
            console.error("[Claw'd Worker] Prompt execution failed");
            // Send error message to channel
            await sendMessage(`[ERROR] Whoops!`);
          }
        } finally {
          isProcessing = false;
        }
      }
    } catch (error) {
      // Catch ALL errors and continue - worker must never die
      console.error(`[Claw'd Worker] Loop error (continuing): ${error}`);
      isProcessing = false;
    }

    await Bun.sleep(POLL_INTERVAL);
  }
}

// Handle graceful shutdown
const clearStreamingState = async () => {
  try {
    await fetch(`${CHAT_API_URL}/api/agent.setStreaming`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        agent_id: AGENT_ID,
        channel: CHANNEL,
        is_streaming: false,
      }),
    });
  } catch {
    /* ignore - best effort cleanup */
  }
};

// Mark all pending messages as seen (but NOT processed) on shutdown.
// This tells the UI the agent has seen the messages (no unread indicators),
// but since they're not marked processed, the agent will pick them up on restart.
const markPendingAsSeen = async () => {
  try {
    const res = await fetch(`${CHAT_API_URL}/api/messages.pending?channel=${CHANNEL}&include_bot=true&limit=50`);
    const data = (await res.json()) as any;
    if (data.ok && data.messages?.length > 0) {
      const maxTs = data.messages.reduce((max: string, m: any) => (m.ts > max ? m.ts : max), "0");
      await fetch(`${CHAT_API_URL}/api/agent.markSeen`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          agent_id: AGENT_ID,
          channel: CHANNEL,
          last_seen_ts: maxTs,
        }),
      });
      console.log(`[Claw'd Worker] Marked messages as seen up to ${maxTs}`);
    }
  } catch {
    /* ignore - best effort cleanup */
  }
};

process.on("SIGINT", async () => {
  console.log("\n[Claw'd Worker] Shutting down...");
  await Promise.all([clearStreamingState(), markPendingAsSeen()]);
  process.exit(0);
});

process.on("SIGTERM", async () => {
  console.log("\n[Claw'd Worker] Terminated");
  await Promise.all([clearStreamingState(), markPendingAsSeen()]);
  process.exit(0);
});

// Run
main().catch(console.error);
