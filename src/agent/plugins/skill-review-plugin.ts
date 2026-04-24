/**
 * Skill Review Plugin — Background skill auto-generation
 *
 * Spawns a read-only sub-agent to review conversation patterns
 * and recommend/auto-create skills after N tool iterations.
 */

import { getSkillSet, improveSkillFromCorrections } from "../skills/improvement";
import { getSkillManager } from "../skills/manager";
import { spawnAgent } from "../subagent/runner";
import { registerSkillReviewTrigger, unregisterSkillReviewTrigger } from "../tools/chat-tools";
import { getContextConfigRoot } from "../utils/agent-context";
import type { Plugin, PluginContext, PluginHooks } from "./manager";

// ── Config ─────────────────────────────────────────────────────────────────

export interface SkillReviewConfig {
  /** Tool call interval between reviews (default: 20) */
  reviewInterval?: number;
  /** Minimum tool calls before first review (default: 10) */
  minToolCallsBeforeFirstReview?: number;
  /** Provider for the review sub-agent. When unset, the sub-agent uses
   *  whatever provider is currently selected (same as its parent). */
  reviewProvider?: string;
  /** Model for the review sub-agent. When unset, the sub-agent falls back
   *  to its runner default — NOT the parent's model. Callers that want
   *  "inherit parent's model" must pass the parent's model explicitly. */
  reviewModel?: string;
  /** Max skills to create per review (default: 2) */
  maxSkillsPerReview?: number;
  /** Cooldown between reviews in ms (default: 300000 = 5 min) */
  reviewCooldownMs?: number;
  /** Claw'd API server URL — required for posting channel notifications */
  apiUrl: string;
  /** Channel ID to post skill notifications */
  channel: string;
  /** Project root for skill storage. Required when the plugin is created
   *  outside an agent context; otherwise falls back to the current agent
   *  context's config root. No CWD fallback — see `projectRoot` resolution
   *  below. */
  projectRoot?: string;
}

// ── Constants ──────────────────────────────────────────────────────────────

const DEFAULT_REVIEW_INTERVAL = 20;
const DEFAULT_MIN_TOOL_CALLS = 10;
const DEFAULT_MAX_SKILLS = 2;
const DEFAULT_COOLDOWN_MS = 300_000; // 5 minutes

// ── Credential Redaction (exported for testing) ───────────────────────────

export const CREDENTIAL_PATTERNS = [
  /(?:api[_-]?key|token|secret|password|credential|auth)["\s:=]+[a-zA-Z0-9_-]{10,}/gi,
  /sk-[a-zA-Z0-9]{20,}/g,
  /sk-proj-[a-zA-Z0-9_-]{20,}/g,
  /ghp_[a-zA-Z0-9]{36}/g,
  /gho_[a-zA-Z0-9]{36}/g,
  /xox[baprs]-[a-zA-Z0-9]{10,}/g,
  /Bearer\s+[a-zA-Z0-9_\-.]+/gi,
  /-----BEGIN\s+(?:RSA\s+)?PRIVATE\s+KEY-----/g,
  /AWS_(?:ACCESS_KEY_ID|SECRET_ACCESS_KEY|DEFAULT_REGION)[=\s][a-zA-Z0-9_-]+/gi,
];

export function sanitize(content: string): string {
  for (const pattern of CREDENTIAL_PATTERNS) {
    content = content.replace(pattern, "[REDACTED]");
  }
  return content;
}

// ── User Correction Detection (exported for testing) ───────────────────────

export const CORRECTION_PATTERNS = [
  /^don't\s/i,
  /^never\s/i,
  /^always\s/i,
  /^use\s+\w+\s+instead/i,
  /instead of\s+/i,
  /remember\s+to\s+/i, // user reminders: "remember to X"
];

export function containsCorrection(text: string): boolean {
  return CORRECTION_PATTERNS.some((p) => p.test(text));
}

export function extractCorrections(messages: any[]): string[] {
  const found: string[] = [];
  for (const msg of messages) {
    if (msg.role !== "user") continue; // only user messages contain corrections
    if (msg.content && containsCorrection(msg.content)) {
      found.push(msg.content.slice(0, 500)); // cap at 500 chars
    }
  }
  return found;
}

// ── Review Prompt Templates ────────────────────────────────────────────────

export function buildSkillReviewPrompt(maxSkills: number): string {
  return `You are a skill reviewer analyzing a conversation transcript.

Your task: Identify patterns that should become reusable skills.

Look for:
1. **Repeated tool sequences** — same 3+ tools used together repeatedly
2. **User corrections** — "don't do X", "always do Y instead"
3. **Project conventions** — patterns specific to this codebase
4. **Complex workflows** — multi-step processes that are well-defined
5. **Tool combinations** — grep → view → edit chains that solve specific problems

For each potential skill, output:
\`\`\`json
{
  "name": "skill-name",
  "description": "Brief description (<200 chars)",
  "triggers": ["keyword1", "keyword2"],
  "rationale": "Why this should be a skill",
  "confidence": "high|medium|low",
  "skillContent": "# Skill body content..."
}
\`\`\`

Only suggest skills with high or medium confidence. Return [] if no good skills found.
Max ${maxSkills} skills.`;
}

export const REVIEW_SUMMARY_PROMPT = `Summarize this skill review in 2-3 sentences for the user.
Skills created: N
Skills suggested but not created: N
Main patterns detected: ...

Keep it brief.`;

// ── Factory ────────────────────────────────────────────────────────────────

export interface SkillReviewDeps {
  /** Override spawnAgent for testing (default: real spawnAgent) */
  spawnAgentFn?: typeof spawnAgent;
  /** Override fetch for testing (default: global fetch) */
  fetchFn?: typeof fetch;
  /** Override SkillManager for testing (default: getSkillManager()) */
  skillManager?: ReturnType<typeof getSkillManager>;
}

export function createSkillReviewPlugin(config: SkillReviewConfig, deps: SkillReviewDeps = {}): { plugin: Plugin } {
  // Allow injection of real or mock implementations for testability
  const { spawnAgentFn = spawnAgent, fetchFn = fetch, skillManager: injectedSm } = deps;
  const skillManagerInstance = injectedSm ?? getSkillManager();

  const reviewInterval = config.reviewInterval ?? DEFAULT_REVIEW_INTERVAL;
  const minToolCalls = config.minToolCallsBeforeFirstReview ?? DEFAULT_MIN_TOOL_CALLS;
  const maxSkills = config.maxSkillsPerReview ?? DEFAULT_MAX_SKILLS;
  const cooldownMs = config.reviewCooldownMs ?? DEFAULT_COOLDOWN_MS;
  const { apiUrl, channel } = config;
  // Guard: prevent divide-by-zero if reviewInterval is 0 or undefined
  const effectiveInterval = reviewInterval > 0 ? reviewInterval : 20;
  // Auto-create is always ON - no config option

  let toolCallCount = 0;
  let lastReviewToolCount = 0; // A1: delta-based trigger tracking
  let reviewCount = 0;
  let lastReviewTime = 0;
  let reviewInProgress = false;
  let pendingCorrections: string[] = [];
  let lastCheckpointSnapshot: string | null = null;

  // Per-turn improvement state (reset at reply_human success gate)
  const turnActivatedSkills = new Set<string>();
  let turnBufferStartIdx = 0;

  // Capture projectRoot in closure for use throughout plugin lifecycle.
  // PluginContext has no projectRoot — must come from config or the agent
  // context (AsyncLocalStorage). No CWD fallback: skills must be scoped to
  // the agent's own project, never the server's launch dir.
  const projectRoot = config.projectRoot ?? getContextConfigRoot();

  // Conversation buffer (circular, max 500 messages)
  const messageBuffer: Array<{
    role: string;
    content: string;
    toolCalls?: Array<{ name: string; args?: string }>;
    toolResult?: { success: boolean; output: string };
    ts: number;
  }> = [];
  const MAX_BUFFER = 500;
  const MAX_CONTENT_SIZE = 2000; // Truncate per-message content to prevent memory exhaustion
  const MAX_PENDING_CORRECTIONS = 100; // SECURITY: cap to prevent unbounded growth

  // ── Credential Sanitization ─────────────────────────────────────────────
  // Redact sensitive patterns before buffering tool results or sending
  // transcripts to the review LLM. Security: prevents credential leakage.
  // References module-level exports for testability.
  void CREDENTIAL_PATTERNS; // module-level export
  void sanitize; // module-level export

  function addToBuffer(entry: (typeof messageBuffer)[0]) {
    // Sanitize + truncate before buffering to prevent credential leakage and memory exhaustion
    const truncate = (text: string | undefined) => {
      if (!text) return text;
      return text.length > MAX_CONTENT_SIZE ? text.slice(0, MAX_CONTENT_SIZE) + " [truncated]" : text;
    };
    const sanitized: (typeof messageBuffer)[0] = {
      ...entry,
      content: entry.content ? sanitize(truncate(entry.content)) : entry.content,
      toolResult: entry.toolResult
        ? { ...entry.toolResult, output: sanitize(truncate(entry.toolResult.output)) }
        : undefined,
    };
    messageBuffer.push(sanitized);
    if (messageBuffer.length > MAX_BUFFER) {
      messageBuffer.shift();
    }
  }

  // ── Snapshot Management (Frozen Pattern) ────────────────────────────────
  // Tracks the LAST checkpoint snapshot — updated after each review and after
  // each compaction. Used to compute delta messages/tool-calls since last checkpoint.

  function captureSnapshot(): string {
    return JSON.stringify({
      ts: Date.now(),
      messageCount: messageBuffer.length,
      toolCalls: toolCallCount,
      reviewCount,
    });
  }

  function getSnapshotDelta(): string {
    if (!lastCheckpointSnapshot) return "First review - no delta";
    try {
      const start = JSON.parse(lastCheckpointSnapshot);
      return `Since session start: ${toolCallCount - start.toolCalls} new tool calls, ${messageBuffer.length - start.messageCount} new messages`;
    } catch {
      return "Unable to compute delta";
    }
  }

  // ── Build Review Transcript ──────────────────────────────────────────────

  function buildReviewTranscript(): string {
    const delta = getSnapshotDelta();
    const lines: string[] = [
      `# Skill Review #${reviewCount + 1}`,
      `Time: ${new Date().toISOString()}`,
      `Tool calls so far: ${toolCallCount}`,
      `Messages in buffer: ${messageBuffer.length}`,
      `Delta: ${delta}`,
      "",
    ];

    // Include user corrections captured during compaction
    if (pendingCorrections.length > 0) {
      lines.push("## User Corrections (from compaction)", "");
      for (const corr of pendingCorrections.slice(0, 10)) {
        lines.push(`- "${corr}"`);
      }
      pendingCorrections = []; // Clear after including
      lines.push("");
    }

    lines.push("## Conversation Transcript", "(last 100 messages, tool calls/results condensed)", "");

    // Add recent messages (last 100, condensed)
    const recent = messageBuffer.slice(-100);
    for (const msg of recent) {
      if (msg.role === "assistant" && msg.toolCalls?.length) {
        const tools = msg.toolCalls.map((t) => t.name).join(" → ");
        lines.push(`[assistant] → Tools: ${tools}`);
      } else if (msg.role === "tool") {
        const preview = msg.content.slice(0, 100).replace(/\n/g, " ");
        lines.push(`  [tool result] ${msg.toolResult?.success ? "✓" : "✗"}: ${preview}...`);
      } else if (msg.content) {
        const preview = msg.content.slice(0, 200).replace(/\n/g, " ");
        lines.push(`[${msg.role}] ${preview}...`);
      }
    }

    return lines.join("\n");
  }

  // ── Run Review ───────────────────────────────────────────────────────────

  async function runReview(ctx: PluginContext): Promise<void> {
    if (reviewInProgress) return;
    if (Date.now() - lastReviewTime < cooldownMs && reviewCount > 0) return;
    if (toolCallCount < minToolCalls && reviewCount === 0) return;

    reviewInProgress = true;
    lastReviewTime = Date.now();
    lastReviewToolCount = toolCallCount; // A1: reset delta counter

    try {
      const transcript = buildReviewTranscript();
      const prompt = `${buildSkillReviewPrompt(maxSkills)}\n\n## Transcript to Analyze\n\n${transcript}`;

      // Spawn review sub-agent (use injected dep for testability)
      const reviewAgent = spawnAgentFn({
        name: `skill-review-${reviewCount + 1}`,
        toolCategory: "read-only",
        maxIterations: 10,
        // depth: actual depth = parent depth + 1 (runner.ts:394). From Agent (depth 0) → depth 1.
        allowSubAgents: false,
        provider: config.reviewProvider,
        model: config.reviewModel,
        systemPrompt: `You are a skill reviewer. Analyze the transcript and output JSON.`,
      });

      // Fire-and-forget with timeout: prevents orphaned reviews from hanging indefinitely.
      // maxIterations=10 limits LLM turns; we also cap total wall time.
      const REVIEW_TIMEOUT_MS = 60_000; // 60 seconds max for the entire review
      const runWithTimeout = () =>
        Promise.race([
          reviewAgent.run(prompt),
          new Promise<never>((_, reject) =>
            setTimeout(
              () => reject(new Error(`Review #${reviewCount + 1} timed out after ${REVIEW_TIMEOUT_MS}ms`)),
              REVIEW_TIMEOUT_MS,
            ),
          ),
        ]);

      runWithTimeout()
        .then(async (result) => {
          if (!result.success || !result.result) {
            console.log(`[SkillReview] Review #${reviewCount + 1} failed: ${result.error}`);
            reviewInProgress = false;
            return;
          }

          // Increment count only after confirming valid result
          reviewCount++;

          // Parse skill recommendations from result
          const rawSkills = parseSkillRecommendations(result.result, projectRoot);

          // A3: Semantic deduplication — filter out skills too similar to existing ones
          const existingSkills = skillManagerInstance
            .listSkills()
            .map((s) => ({ name: s.name, triggers: s.triggers ?? [] }));
          const skills = rawSkills.filter((s) => !isDuplicateSkill(s, existingSkills));

          if (skills.length === 0) {
            console.log(`[SkillReview] Review #${reviewCount}: no new skills found (${rawSkills.length} deduped)`);
            reviewInProgress = false;
            return;
          }

          // Save skills (always auto-create)
          const skillManager = skillManagerInstance;
          const createdSkills: Array<{ name: string; description: string; path: string }> = [];
          const failedSkills: string[] = [];

          for (const skill of skills.slice(0, maxSkills)) {
            // Security: check for naming collision before saving
            const existing = skillManager.getSkill(skill.name);
            if (existing) {
              console.log(
                `[SkillReview] Skill '${skill.name}' already exists — skipping (auto-generated skills cannot overwrite existing skills)`,
              );
              failedSkills.push(`${skill.name} (collision)`);
              continue;
            }

            const saveResult = skillManager.saveSkill(
              {
                name: skill.name,
                description: skill.description,
                triggers: skill.triggers,
                content: skill.skillContent,
                version: "1.0.0",
                autoGenerated: true, // A4: mark as auto-generated for TTL cleanup
              },
              "project", // Skills go to project scope by default
            );

            if (saveResult.success) {
              createdSkills.push({
                name: skill.name,
                description: skill.description,
                path: `.clawd/skills/${skill.name}/SKILL.md`,
              });
              console.log(`[SkillReview] Created skill: ${skill.name}`);
            } else {
              failedSkills.push(skill.name);
              console.log(
                `[SkillReview] Failed to create skill: ${skill.name} - ${saveResult.error ?? "Unknown error"}`,
              );
            }
          }

          // Post compact System message to channel (no emojis)
          if (createdSkills.length > 0) {
            postSystemMessage(apiUrl, channel, createdSkills, failedSkills.length, fetchFn);
          }

          // Update snapshot after review
          lastCheckpointSnapshot = captureSnapshot();

          console.log(
            `[SkillReview] Review #${reviewCount} complete: ${createdSkills.length} created, ${failedSkills.length} failed`,
          );
          reviewInProgress = false;
        })
        .catch((err) => {
          console.error(`[SkillReview] Review agent error:`, err);
          reviewInProgress = false; // Always reset so future reviews can proceed
        });
    } catch (err) {
      console.error(`[SkillReview] Review failed:`, err);
      reviewInProgress = false;
    }
  }

  // ── User Correction Detection ───────────────────────────────────────────
  // Lightweight pattern detection for user corrections in dropped messages.
  // Used by beforeCompaction to preserve critical user preferences.
  // References module-level exports for testability.
  void CORRECTION_PATTERNS; // module-level export
  void containsCorrection; // module-level export
  void extractCorrections; // module-level export

  // ── Plugin Hooks ─────────────────────────────────────────────────────────

  const pluginHooks: PluginHooks = {
    // NOTE: PluginHooks has NO `onUserMessage` hook — it would be silently ignored.
    // Do NOT add it. User messages are not captured via plugin hooks.
    async onInit(_ctx: PluginContext) {
      // Capture initial snapshot at plugin init time (Phase 2)
      lastCheckpointSnapshot = captureSnapshot();
      // Register manual trigger so trigger_skill_review tool works
      registerSkillReviewTrigger(() => runReview(_ctx));
      // Clear in-flight improvement set in case of restart (prevents permanent skill lock)
      getSkillSet(projectRoot).clear();
      console.log("[SkillReview] Plugin initialized, snapshot captured");
    },

    async onAgentResponse(response: any, _ctx: PluginContext) {
      if (response?.content) {
        addToBuffer({
          role: "assistant",
          content: response.content,
          ts: Date.now(),
        });
      }

      // Capture skill_activate calls to track which skills were used this turn.
      // Source: response.toolCalls[] (content is a string — cannot be parsed for tool names).
      // NO resets here — resets happen at reply_human consumption gate only.
      const toolCalls = Array.isArray(response?.toolCalls) ? response.toolCalls : [];
      for (const tc of toolCalls) {
        if (tc?.name !== "skill_activate") continue;
        let args: any = tc.args;
        if (typeof args === "string") {
          try {
            args = JSON.parse(args);
          } catch {
            args = {};
          }
        }
        const skillName = args?.name;
        if (typeof skillName === "string" && skillName.length > 0) {
          turnActivatedSkills.add(skillName);
        }
      }
    },

    async onToolResult(name: string, result: any, _ctx: PluginContext) {
      toolCallCount++;
      addToBuffer({
        role: "tool",
        content: result?.output || result?.error || "",
        toolResult: { success: result?.success ?? false, output: result?.output || "" },
        ts: Date.now(),
      });

      // Skill self-improvement: fire at task completion (reply_human success = turn end).
      // Skip SILENT replies — those are heartbeat / no-op turns with no content worth reviewing.
      // Snapshot BEFORE any path that might consume pendingCorrections.
      const replyIsSilent = (() => {
        if (name !== "reply_human") return false;
        try {
          const parsed = typeof result?.output === "string" ? JSON.parse(result.output) : null;
          return parsed?.silent === true;
        } catch {
          return false;
        }
      })();
      if (name === "reply_human" && result?.success !== false && !replyIsSilent) {
        const correctionsSnapshot = [...pendingCorrections];
        const activatedSnapshot = [...turnActivatedSkills];
        const MAX_TURN_SLICE = 8_000;
        const rawSlice = messageBuffer
          .slice(turnBufferStartIdx)
          .map((e) => `[${e.role}] ${e.content}`)
          .join("\n");
        // Preserve the HEAD of the turn: user corrections and skill_activate calls appear
        // early in the buffer, so head-slicing keeps the context the improvement LLM needs most.
        const turnSlice =
          rawSlice.length > MAX_TURN_SLICE ? rawSlice.slice(0, MAX_TURN_SLICE) + " [truncated]" : rawSlice;

        // Reset per-turn state AFTER snapshot.
        // pendingCorrections is NOT cleared here — buildReviewTranscript() owns that reset
        // so the review agent can still see corrections when improvement also fires in the same event.
        turnActivatedSkills.clear();
        turnBufferStartIdx = messageBuffer.length;

        // Fire improvement (correction-gated, async fire-and-forget)
        if (correctionsSnapshot.length > 0 && activatedSnapshot.length > 0) {
          for (const skillName of activatedSnapshot) {
            if (getSkillSet(projectRoot).has(skillName)) continue;
            // acquireImprovementToken() is now called inside improveSkillFromCorrections
            // after the credential check, so no bucket slot is wasted on missing credentials.
            getSkillSet(projectRoot).add(skillName);
            improveSkillFromCorrections(skillName, correctionsSnapshot, turnSlice, projectRoot)
              .finally(() => getSkillSet(projectRoot).delete(skillName))
              .catch((err) => console.error("[SkillImprovement]", err));
          }
        }
      }

      // A1: Fire review after task completion (reply_human = turn end) with delta-based gate.
      // This replaces the old per-N-tool-call modulo trigger so review fires at task boundaries.
      // Skip SILENT replies — heartbeat turns produce no content worth reviewing.
      if (
        name === "reply_human" &&
        result?.success !== false &&
        !replyIsSilent &&
        !reviewInProgress &&
        toolCallCount >= minToolCalls &&
        toolCallCount - lastReviewToolCount >= effectiveInterval
      ) {
        runReview(_ctx).catch((err) => {
          console.error(`[SkillReview] Async review error:`, err);
        });
      }
    },

    async beforeCompaction(droppedMessages: any[], _ctx: PluginContext) {
      // Capture critical user corrections before compaction so they aren't lost.
      // These are stored temporarily and included in the next review's transcript.
      // SECURITY: Cap pendingCorrections to prevent unbounded memory growth
      const corrections = extractCorrections(droppedMessages);
      if (corrections.length > 0) {
        pendingCorrections.push(...corrections);
        if (pendingCorrections.length > MAX_PENDING_CORRECTIONS) {
          pendingCorrections = pendingCorrections.slice(-MAX_PENDING_CORRECTIONS);
        }
        console.log(
          `[SkillReview] Compaction: ${droppedMessages.length} messages dropped, ${corrections.length} corrections extracted`,
        );
      } else {
        console.log(`[SkillReview] Compaction: ${droppedMessages.length} messages dropped`);
      }
    },

    async onCompaction(_deleted: number, _remaining: number, _ctx: PluginContext) {
      // Update snapshot after compaction
      lastCheckpointSnapshot = captureSnapshot();
    },

    async onShutdown() {
      // NOTE: onShutdown has NO ctx parameter. Project root is captured in closure (projectRoot).
      // Unregister the manual trigger so it won't fire after shutdown
      unregisterSkillReviewTrigger();
      // NOTE: Fire-and-forget on shutdown — process may exit before review completes.
      // This is acceptable; the review will be lost but no state corruption occurs.
      if (toolCallCount >= minToolCalls && !reviewInProgress) {
        console.log(`[SkillReview] Final review on shutdown (${toolCallCount} tool calls)`);
        // runReview() needs PluginContext — pass a minimal mock for shutdown
        const shutdownCtx: PluginContext = {
          agentId: "",
          model: config.reviewModel ?? "unknown",
        };
        runReview(shutdownCtx).catch((err) => {
          console.error(`[SkillReview] Final review error:`, err);
        });
      }
    },
  };

  const plugin: Plugin = {
    name: "skill-review",
    version: "1.0.0",
    description: "Background skill auto-generation from conversation patterns",
    hooks: pluginHooks,
  };

  return { plugin };
}

// ── System Message ─────────────────────────────────────────────────────────

// ── SSRF Protection ─────────────────────────────────────────────────────────
/**
 * SECURITY: Proper IP range checking for SSRF protection.
 * Uses numeric IP parsing instead of regex to avoid IPv6 bypass attacks.
 * Covers: IPv4 private ranges, IPv4-mapped IPv6, all expanded IPv6 forms.
 */
function isPrivateIPv4(ip: number): boolean {
  const b0 = (ip >>> 24) & 0xff;
  const b1 = (ip >>> 16) & 0xff;
  return b0 === 10 || (b0 === 172 && b1 >= 16 && b1 <= 31) || (b0 === 192 && b1 === 168) || b0 === 127;
}

function parseIPv4(hostname: string): number | null {
  const parts = hostname.split(".");
  if (parts.length !== 4) return null;
  // Parse each octet as a C-language octal or decimal integer.
  // This matches Node.js/Bun URL parser IP normalization per WHATWG URL Standard.
  // Exploit: without this, "010.010.010.010" (→ 8.8.8.8 public) passes
  // our private-range check as 10.10.10.10 → SSRF bypass.
  const nums = parts.map((p) => {
    // Leading-zero octets → treat as octal (e.g. "010" → 8, "0200" → 128)
    const n = parseInt(p, p.startsWith("0") && p.length > 1 ? 8 : 10);
    if (isNaN(n) || n < 0 || n > 255) return null;
    return n;
  });
  if (nums.some((n) => n === null)) return null;
  return ((nums[0] << 24) | (nums[1] << 16) | (nums[2] << 8) | nums[3]) >>> 0;
}

function expandIPv6(hostname: string): string[] | null {
  // Handle loopback and empty
  const clean = hostname.replace(/^\[|\]$/g, "");
  if (clean === "::1") return ["0", "0", "0", "0", "0", "0", "0", "1"];
  if (clean === "::") return ["0", "0", "0", "0", "0", "0", "0", "0"];

  // Handle IPv4-mapped: ::ffff:192.168.1.1
  const ipv4Mapped = clean.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
  if (ipv4Mapped) {
    const ip = parseIPv4(ipv4Mapped[1]);
    if (ip === null) return null;
    const b = [(ip >>> 24) & 0xff, (ip >>> 16) & 0xff, (ip >>> 8) & 0xff, ip & 0xff];
    // Return hex strings for all groups so isPrivateIPv6 can parse them
    return ["0", "0", "0", "0", b[0].toString(16), b[1].toString(16), b[2].toString(16), b[3].toString(16)];
  }

  // Expand compressed form
  const parts = clean.split(":");
  const nonEmpty: string[] = [];
  let emptyCount = 0;

  for (const p of parts) {
    if (p === "") {
      emptyCount++;
    } else {
      const n = parseInt(p, 16);
      if (isNaN(n) || n < 0 || n > 0xffff) return null;
      nonEmpty.push(p); // Keep hex string so isPrivateIPv6 can parse it
    }
  }

  if (emptyCount === 0 && nonEmpty.length === 8) {
    return nonEmpty;
  }
  if (emptyCount === 1) {
    // Find the :: position in the original parts array
    const emptyIdx = parts.indexOf("");
    // filled = nonEmpty entries before the ::
    const filled = nonEmpty.slice(0, emptyIdx);
    // tail = nonEmpty entries after the ::
    const tail = nonEmpty.slice(emptyIdx);
    const zeros = new Array(8 - nonEmpty.length).fill("0");
    return [...filled, ...zeros, ...tail];
  }
  return null;
}

function isPrivateIPv6(hostname: string): boolean {
  try {
    const clean = hostname.replace(/^\[|\]$/g, "");
    if (clean === "::1" || clean === "::") return true;

    // Handle IPv4-mapped IPv6 from URL parsing:
    // Input: [::ffff:127.0.0.1] becomes hostname [::ffff:7f00:1] after URL parsing.
    // The URL parser converts ::ffff:A.B.C.D to ::ffff:HHLL:X where HHLL is hex
    // of (A<<8|B) and X is D (single digit). We recover the first two bytes.
    // This is sufficient to identify 10.x.x.x (private), 127.x.x.x (loopback),
    // 172.16-31.x.x (private), and 192.168.x.x (private).
    const ipv4Mapped = clean.match(/^::ffff:([0-9a-f]{1,4}):(\d+)$/i);
    if (ipv4Mapped) {
      const hexPart = ipv4Mapped[1];
      const lastByte = parseInt(ipv4Mapped[2], 10);
      const hiWord = parseInt(hexPart, 16);
      const b0 = (hiWord >>> 8) & 0xff; // First IPv4 byte
      const b1 = hiWord & 0xff; // Second IPv4 byte
      // With b0 and lastByte (and b1 partial), we can identify:
      if (b0 === 10) return true; // 10.x.x.x is always private
      if (b0 === 127) return true; // 127.x.x.x is loopback
      if (lastByte >= 1 && lastByte <= 9) {
        // Single-digit last byte — identify known private ranges
        if (b0 === 172 && b1 >= 16 && b1 <= 31) return true; // 172.16-31.x.x
        if (b0 === 192 && b1 === 168) return true; // 192.168.x.x
      }
      return false; // Cannot determine for multi-digit last bytes — reject
    }

    // Handle general IPv6 (compressed or expanded)
    if (/^[0-9a-f]{0,4}(:[0-9a-f]{0,4})+$/i.test(clean)) {
      const groups = expandIPv6(clean);
      if (!groups || groups.length !== 8) return false;
      const g0 = parseInt(groups[0], 16);
      if (g0 >= 0xfc00 && g0 <= 0xfdff) return true; // fc00::/7
      if (g0 >= 0xfe80 && g0 <= 0xfeff) return true; // fe80::/10
      if (g0 === 0) {
        // Check if loopback (::1)
        return groups[7] === "1" && groups.slice(0, 7).every((g) => g === "0");
      }
      return false;
    }

    return false;
  } catch {
    return false;
  }
}

export function isSafeApiUrl(url: string): boolean {
  // Pre-check: handle unbracketed IPv6 that may cause URL parser to throw
  // e.g. "http://::1:3000/mcp" → hostname "::1" (per RFC 3986)
  // These should be treated the same as bracketed forms
  const ipv6WithoutBrackets = url.match(/^https?:\/\/([0-9a-f:]+):(\d+)\//i);
  if (ipv6WithoutBrackets) {
    const potentialIPv6 = ipv6WithoutBrackets[1];
    if (potentialIPv6.includes("::") || potentialIPv6.includes(":")) {
      // Likely unbracketed IPv6 — check via isPrivateIPv6
      if (isPrivateIPv6(potentialIPv6)) return true;
    }
  }

  try {
    const parsed = new URL(url);
    const hostname = parsed.hostname;

    // Allow localhost variants
    if (hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]" || hostname === "::1") {
      return true;
    }

    // Allow .local mDNS
    if (hostname.endsWith(".local")) {
      return true;
    }

    // Check IPv4
    const ip = parseIPv4(hostname);
    if (ip !== null) {
      // Block 169.254.0.0/16 (link-local / AWS metadata service)
      const b0 = (ip >>> 24) & 0xff;
      const b1 = (ip >>> 16) & 0xff;
      if (b0 === 169 && b1 === 254) return false;
      return isPrivateIPv4(ip);
    }

    // Check IPv6 (handles all forms: compressed, expanded, IPv4-mapped)
    if (isPrivateIPv6(hostname)) {
      return true;
    }

    // Reject all others (public IPs, unknown hostnames)
    return false;
  } catch {
    return false;
  }
}

export async function postSystemMessage(
  apiUrl: string,
  channel: string,
  created: Array<{ name: string; description: string; path: string }>,
  failedCount: number,
  httpFetch: typeof fetch = fetch,
): Promise<void> {
  const lines: string[] = [];

  for (const skill of created) {
    // SECURITY: Escape to prevent markdown injection in notification
    const safeName = skill.name.replace(/[<>[\]]/g, "\\$&");
    const safeDesc = skill.description.replace(/[<>[\]]/g, "\\$&");
    const safePath = skill.path.replace(/[<>[\]]/g, "\\$&");
    lines.push(`Skill created: ${safeName} — ${safeDesc} (${safePath})`);
  }

  if (failedCount > 0) {
    lines.push(`${failedCount} skill(s) failed to save`);
  }

  const message = lines.join("\n");

  // Security: validate apiUrl before making any HTTP request to prevent SSRF
  if (!isSafeApiUrl(apiUrl)) {
    console.error("[SkillReview] Rejected unsafe apiUrl:", apiUrl);
    return;
  }

  // POST to Claw'd API using the same pattern as ClawdChatAgentPlugin._sendMessage()
  // Ref: src/agent/plugins/clawd-chat/agent.ts:183-206
  try {
    await httpFetch(`${apiUrl}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: Date.now(),
        method: "tools/call",
        params: {
          name: "reply_human",
          arguments: { channel, text: message },
        },
      }),
    });
  } catch (err) {
    console.error("[SkillReview] Failed to post system message:", err);
  }
}

// ── Semantic Deduplication ────────────────────────────────────────────────

/** Simple Levenshtein distance for short strings (names ≤ 64 chars). */
export function levenshtein(a: string, b: string): number {
  const m = a.length,
    n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, (_, i) =>
    Array(n + 1)
      .fill(0)
      .map((_, j) => (i === 0 ? j : j === 0 ? i : 0)),
  );
  for (let i = 1; i <= m; i++)
    for (let j = 1; j <= n; j++)
      dp[i][j] = a[i - 1] === b[j - 1] ? dp[i - 1][j - 1] : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
  return dp[m][n];
}

/**
 * Returns true if candidate skill is a duplicate of any existing skill.
 * Checks: name edit-distance ≤ 2, or any shared trigger keyword.
 */
export function isDuplicateSkill(
  candidate: { name: string; triggers: string[] },
  existing: Array<{ name: string; triggers: string[]; auto?: boolean }>,
): boolean {
  const candName = candidate.name.toLowerCase();
  const candTriggers = new Set(candidate.triggers.map((t) => t.toLowerCase()));
  for (const skill of existing) {
    if (levenshtein(candName, skill.name.toLowerCase()) <= 2) return true;
    const skillTriggers = skill.triggers.map((t) => t.toLowerCase());
    if (skillTriggers.some((t) => candTriggers.has(t))) return true;
  }
  return false;
}

// ── Helpers ────────────────────────────────────────────────────────────────

// Security: validate skill content to prevent injection attacks.
// skillContent is untrusted LLM output and must be treated as such.
const MAX_CONTENT_LENGTH = 10_000; // 10KB max per skill
const MAX_NAME_LENGTH = 64;
const MAX_TRIGGERS = 10;

// Block patterns that attempt to override agent instructions or exfiltrate data
const INJECTION_PATTERNS: RegExp[] = [
  /ignore\s+all\s+previous\s+instructions?/i,
  /disregard\s+(all\s+)?previous/i,
  /forget\s+(all\s+)?(previous|instruct)/i,
  /\$\{[^}]+\}/i, // matches ${ENV_VAR}, ${env:KEY}, ${process.env.XXX}, etc.
  /\$\([^)]+\)/,
  /<script[\s>]/i,
  /data:(?:text|application)\//i,
  /javascript:/i,
];

export function isInjectionFree(content: string): boolean {
  return !INJECTION_PATTERNS.some((p) => p.test(content));
}

// Validate skill name against the same regex used by SkillManager
// SKILL_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/
const SKILL_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;

export function parseSkillRecommendations(
  resultText: string,
  _projectRoot: string, // future use for path validation
): Array<{
  name: string;
  description: string;
  triggers: string[];
  rationale: string;
  confidence: string;
  skillContent: string;
}> {
  try {
    // Extract JSON from result (handle markdown code blocks)
    const jsonMatch = resultText.match(/```json\s*([\s\S]*?)\s*```|(\[[\s\S]*\])/);
    if (!jsonMatch) return [];

    const jsonStr = jsonMatch[1] || jsonMatch[2];
    const parsed = JSON.parse(jsonStr);

    if (!Array.isArray(parsed)) return [];
    return parsed.filter((s) => {
      // Structural validation
      if (!s.name || !s.description || !s.triggers?.length || !s.skillContent) return false;
      if (s.confidence !== "high" && s.confidence !== "medium") return false;
      // Schema bounds
      if (s.name.length > MAX_NAME_LENGTH) return false;
      if (s.description.length > 200) return false;
      if (s.triggers.length > MAX_TRIGGERS) return false;
      if (s.skillContent.length > MAX_CONTENT_LENGTH) return false;
      // Skill name must match SKILL_NAME_RE
      if (!SKILL_NAME_RE.test(s.name)) return false;
      // Security: block injection patterns in content
      if (!isInjectionFree(s.skillContent)) return false;
      return true;
    });
  } catch {
    return [];
  }
}
