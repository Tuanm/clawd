/**
 * JSONL Rebuilder: reconstruct a Claude Code SDK session file from memory.db rows.
 *
 * Used when an agent switches from a non-CC provider (e.g. OpenAI, Gemini) to a
 * CC-based provider. The new CC session has no native JSONL history, so we
 * synthesize one from the agent's stored messages. The SDK then resumes from
 * our hand-written file as if it were a real CC session.
 *
 * Strategy: strip tool_use blocks but preserve assistant text content, replace
 * tool calls with a `[Used: <names>]` placeholder line. This preserves the
 * narrative without orphaned tool_use blocks (memory.db doesn't store
 * SDK-shaped tool results).
 *
 * Spike (scripts/spike-jsonl-resume.ts) proved that the SDK accepts a hand-
 * written JSONL file at `~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl`
 * and loads its contents into model context on resume.
 */

import { mkdir, realpath, rename, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { getSessionManager, type StoredMessage } from "./manager";

/** Cap on memory rows replayed into JSONL — the SDK loads the entire file. */
const MAX_REPLAY_MESSAGES = 200;
/** Byte cap on the rendered JSONL content (excluding header lines). Prevents
 *  one giant memory.db row (e.g. multi-MB file paste) from blowing past the
 *  model's context window on the next turn. Walks newest-first and stops when
 *  exceeded so recency wins. */
const MAX_REPLAY_BYTES = 800_000;

/** Encode a cwd into the directory name used by ~/.claude/projects.
 *  Verified against SDK source (cli.js v2.1.81, function `UM`): replace ANY
 *  non-alphanumeric character with `-`. Real CC sessions confirm this rule
 *  exactly. The previous narrower rule (slash/dot only) diverged for paths
 *  containing `_`, `~`, spaces, etc. */
function encodeCwd(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, "-");
}

/** Render an assistant row's content for the JSONL: keep text, append a
 *  placeholder line for any stored tool calls. Returns null if the row would
 *  produce an empty assistant turn (no text, no tools). */
function renderAssistantContent(row: StoredMessage): string | null {
  const text = (row.content || "").trim();

  let toolNames: string[] = [];
  if (row.tool_calls) {
    try {
      const calls = JSON.parse(row.tool_calls);
      if (Array.isArray(calls)) {
        toolNames = calls
          .map((c: any) => c?.function?.name || c?.name)
          .filter((n: unknown): n is string => typeof n === "string" && n.length > 0);
      }
    } catch {
      // Malformed JSON — fall through with empty toolNames
    }
  }

  const placeholder = toolNames.length > 0 ? `[Used: ${toolNames.join(", ")}]` : row.tool_calls ? `[tools used]` : "";

  if (!text && !placeholder) return null;
  if (!text) return placeholder;
  if (!placeholder) return text;
  return `${text}\n\n${placeholder}`;
}

export interface RebuildResult {
  sessionId: string;
  jsonlPath: string;
  userTurns: number;
  assistantTurns: number;
}

export interface RebuildOptions {
  channel: string;
  agentId: string;
  /** Effective project root — must match the cwd the SDK will be invoked with. */
  projectRoot: string;
  /** Model name stamped onto synthesized assistant turns; cosmetic. */
  model?: string;
}

/**
 * Build a JSONL session file from memory.db. Returns null when there is no
 * usable history (no session, no rows, all rows skipped). Throws on filesystem
 * errors — caller decides whether to fall back to the bridge-summary path.
 *
 * Async: filesystem ops use `fs/promises` so they don't block the Bun event
 * loop during a PATCH request (the handler holds the per-agent lock until
 * this resolves; sync writes would stall every other request behind it).
 */
export async function rebuildClaudeCodeJsonlFromMemory(opts: RebuildOptions): Promise<RebuildResult | null> {
  const { channel, agentId } = opts;
  const model = opts.model || "claude-sonnet-4-6";

  // Canonicalize the project root so the encoded directory matches whatever
  // the SDK derives from its own cwd. realpath also catches symlinked /home,
  // /tmp, and similar mounts that would otherwise drift the encoding.
  let projectRoot = opts.projectRoot;
  try {
    projectRoot = await realpath(opts.projectRoot);
  } catch {
    // Path may not exist yet; fall back to the as-provided value.
  }

  const sessionName = `${channel}-${agentId.replace(/[^a-zA-Z0-9]/g, "_")}`;
  const sm = getSessionManager();
  const session = sm.getSession(sessionName);
  if (!session) return null;

  const allRows = sm.getAllStoredMessages(session.id);
  if (!allRows || allRows.length === 0) return null;

  // Apply both row cap and byte cap. Walk from the tail backward; stop when
  // either limit is hit. The byte budget protects against one massive row
  // (long file paste) blowing past the model context window on next turn.
  const windowed: StoredMessage[] = [];
  let bytesUsed = 0;
  for (let i = allRows.length - 1; i >= 0 && windowed.length < MAX_REPLAY_MESSAGES; i--) {
    const row = allRows[i];
    const rowBytes = (row.content?.length ?? 0) + (row.tool_calls?.length ?? 0);
    if (bytesUsed + rowBytes > MAX_REPLAY_BYTES && windowed.length > 0) break;
    bytesUsed += rowBytes;
    windowed.unshift(row);
  }
  // Snap window start to the first user row. The spike only verified chains
  // rooted at a user turn; an assistant-rooted chain with parentUuid:null is
  // an unverified SDK path. If no user row exists in the window, bail.
  const firstUserIdx = windowed.findIndex((r) => r.role === "user");
  if (firstUserIdx === -1) return null;
  const rows = firstUserIdx > 0 ? windowed.slice(firstUserIdx) : windowed;

  const newSessionId = crypto.randomUUID();
  const encodedCwd = encodeCwd(projectRoot);
  const projectDir = join(homedir(), ".claude", "projects", encodedCwd);
  await mkdir(projectDir, { recursive: true });

  const jsonlPath = join(projectDir, `${newSessionId}.jsonl`);
  const tmpPath = `${jsonlPath}.tmp-${process.pid}-${Date.now()}`;

  const lines: string[] = [];

  // Queue-operation header lines mirror what the real CC SDK writes at session
  // start. Including them keeps the file shape close to organic sessions.
  const headerTs = new Date(rows[0].created_at || Date.now()).toISOString();
  lines.push(
    JSON.stringify({ type: "queue-operation", operation: "enqueue", timestamp: headerTs, sessionId: newSessionId }),
  );
  lines.push(
    JSON.stringify({ type: "queue-operation", operation: "dequeue", timestamp: headerTs, sessionId: newSessionId }),
  );

  let userTurns = 0;
  let assistantTurns = 0;
  // prevUuid advances only on emitted rows. Skipped rows ([CONTEXT SUMMARY],
  // empty content, tool/system) deliberately do not break the parent chain —
  // the next emitted turn chains to the last *emitted* turn.
  let prevUuid: string | null = null;

  for (const row of rows) {
    const ts = new Date(row.created_at || Date.now()).toISOString();
    const uuid = crypto.randomUUID();

    if (row.role === "user") {
      // Skip compaction-summary rows. Canonical marker is `created_at === 0`
      // (set by SessionManager.setConversationSummary / compactSession).
      // Filtering by content prefix would also drop genuine user messages
      // that happen to start with "[CONTEXT SUMMARY".
      if (row.created_at === 0) continue;
      const content = (row.content || "").trim();
      if (!content) continue;

      lines.push(
        JSON.stringify({
          parentUuid: prevUuid,
          isSidechain: false,
          promptId: crypto.randomUUID(),
          type: "user",
          message: {
            role: "user",
            content: [{ type: "text", text: content }],
          },
          uuid,
          timestamp: ts,
          permissionMode: "bypassPermissions",
          userType: "external",
          entrypoint: "sdk-ts",
          cwd: projectRoot,
          sessionId: newSessionId,
          version: "2.1.81",
          gitBranch: "HEAD",
        }),
      );
      userTurns++;
      prevUuid = uuid;
      continue;
    }

    if (row.role === "assistant") {
      const rendered = renderAssistantContent(row);
      if (!rendered) continue;

      lines.push(
        JSON.stringify({
          parentUuid: prevUuid,
          isSidechain: false,
          message: {
            id: crypto.randomUUID(),
            type: "message",
            role: "assistant",
            content: [{ type: "text", text: rendered }],
            model,
            stop_reason: "end_turn",
            stop_sequence: null,
            usage: {
              input_tokens: 0,
              output_tokens: 0,
              cache_creation_input_tokens: 0,
              cache_read_input_tokens: 0,
            },
            service_tier: "standard",
          },
          // Required on every assistant line per real CC sessions; SDK reads
          // it when classifying API-error turns. Hand-written turns aren't errors.
          isApiErrorMessage: false,
          type: "assistant",
          uuid,
          timestamp: ts,
          userType: "external",
          entrypoint: "sdk-ts",
          cwd: projectRoot,
          sessionId: newSessionId,
          version: "2.1.81",
          gitBranch: "HEAD",
        }),
      );
      assistantTurns++;
      prevUuid = uuid;
    }

    // tool / system rows: skip
  }

  if (userTurns === 0 && assistantTurns === 0) {
    // Nothing replayable — abort without creating an empty session file.
    return null;
  }

  try {
    await writeFile(tmpPath, lines.join("\n") + "\n");
    await rename(tmpPath, jsonlPath);
  } catch (err) {
    // writeFile may have created the tmp file before failing; rename may have
    // failed leaving it on disk. Clean up so we don't leak.
    try {
      await unlink(tmpPath);
    } catch {}
    throw err;
  }

  return { sessionId: newSessionId, jsonlPath, userTurns, assistantTurns };
}
