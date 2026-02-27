/**
 * Message importance scoring for smart compaction.
 *
 * Replaces "keep last N" with importance-weighted selection.
 * Messages transition through 3 lifecycle stages:
 *   FULL (>60) → COMPRESSED (30-60) → DROPPED (<30)
 */

import type { Message } from "../api/client";
import { estimateTokens } from "../memory/memory";
import { smartTruncate } from "../utils/smart-truncation";

// ── Scoring Constants ──────────────────────────────────────────────

const BASE_WEIGHTS: Record<string, number> = {
  system: 100,
  user: 90,
  assistant_tool_calls: 70,
  assistant_text: 50,
  tool_error: 80,
  tool_success: 40,
};

const CATEGORY_BONUS = {
  taskDefinition: 45,
  decision: 35,
  errorResolution: 30,
  planUpdate: 25,
  acknowledgment: -20,
};

const RECENCY_HALF_LIFE = 28; // ~28 messages for half-life
const REFERENCE_BONUS = 10;

// ── Stage Thresholds ───────────────────────────────────────────────

export const STAGE_FULL = 60;
export const STAGE_COMPRESSED = 30;

export type MessageStage = "FULL" | "COMPRESSED" | "DROPPED";

export interface ScoredMessage {
  message: Message;
  index: number;
  score: number;
  stage: MessageStage;
  isAnchor: boolean; // task descriptions, unresolved errors — always kept
  atomicGroupId?: string; // tool_call + results grouped together
}

// ── Scoring ────────────────────────────────────────────────────────

export function scoreMessages(messages: Message[]): ScoredMessage[] {
  const total = messages.length;
  if (total === 0) return [];

  // Build reference map in O(n)
  const referenceCount = new Map<number, number>();
  const contentMap = new Map<number, string>();
  for (let i = 0; i < total; i++) {
    const content = messages[i].content || "";
    contentMap.set(i, content);
    referenceCount.set(i, 0);
  }
  // Simple reference detection: later messages mentioning earlier content keywords
  // Limit to last 50 messages checking last 50 earlier messages to avoid O(n²) on large sessions
  const refStart = Math.max(1, total - 50);
  for (let i = refStart; i < total; i++) {
    const content = contentMap.get(i) || "";
    if (content.length < 10) continue;
    const jStart = Math.max(0, i - 50);
    for (let j = jStart; j < i; j++) {
      const earlier = contentMap.get(j) || "";
      if (earlier.length < 10) continue;
      // Check if later message references earlier by file paths or key phrases
      const words = extractKeyTerms(earlier);
      for (const w of words) {
        if (content.includes(w)) {
          referenceCount.set(j, (referenceCount.get(j) || 0) + 1);
          break; // Count each reference once per later message
        }
      }
    }
  }

  // Build atomic groups (tool_call → tool_results)
  const atomicGroups = buildAtomicGroups(messages);

  // Score each message
  const scored: ScoredMessage[] = messages.map((msg, i) => {
    if (msg.role === "system") {
      return {
        message: msg,
        index: i,
        score: 100,
        stage: "FULL" as MessageStage,
        isAnchor: true,
        atomicGroupId: atomicGroups.get(i),
      };
    }

    // Base weight
    let base = BASE_WEIGHTS.user;
    if (msg.role === "assistant") {
      base =
        msg.tool_calls && msg.tool_calls.length > 0 ? BASE_WEIGHTS.assistant_tool_calls : BASE_WEIGHTS.assistant_text;
    } else if (msg.role === "tool") {
      const content = msg.content || "";
      base = isErrorContent(content) ? BASE_WEIGHTS.tool_error : BASE_WEIGHTS.tool_success;
    }

    // Recency decay
    const age = total - 1 - i;
    const recency = Math.exp(-age / (RECENCY_HALF_LIFE / Math.LN2));

    // Category bonuses
    let bonus = 0;
    const content = msg.content || "";
    if (msg.role === "user" && i === 0) bonus += CATEGORY_BONUS.taskDefinition;
    if (isTaskDefinition(content)) bonus += CATEGORY_BONUS.taskDefinition;
    if (containsDecision(content)) bonus += CATEGORY_BONUS.decision;
    if (containsErrorResolution(content)) bonus += CATEGORY_BONUS.errorResolution;
    if (containsPlanUpdate(content)) bonus += CATEGORY_BONUS.planUpdate;
    if (msg.role === "user" && isAcknowledgment(content)) bonus += CATEGORY_BONUS.acknowledgment;

    // Reference bonus
    const refs = referenceCount.get(i) || 0;
    bonus += Math.min(refs, 5) * REFERENCE_BONUS; // Cap at 5 references

    // Final score clamped to [0, 100]
    const rawScore = base * recency + bonus;
    const score = Math.max(0, Math.min(100, rawScore));

    // Determine stage
    let stage: MessageStage = "DROPPED";
    if (score > STAGE_FULL) stage = "FULL";
    else if (score >= STAGE_COMPRESSED) stage = "COMPRESSED";

    // Anchor detection
    const isAnchor = isTaskDefinition(content) || isUnresolvedError(content) || i === 0 || i === total - 1;

    return { message: msg, index: i, score, stage, isAnchor, atomicGroupId: atomicGroups.get(i) };
  });

  // Atomic group scoring: entire group gets max score of its members
  const groupScores = new Map<string, number>();
  for (const s of scored) {
    if (s.atomicGroupId) {
      const current = groupScores.get(s.atomicGroupId) || 0;
      groupScores.set(s.atomicGroupId, Math.max(current, s.score));
    }
  }
  for (const s of scored) {
    if (s.atomicGroupId && groupScores.has(s.atomicGroupId)) {
      s.score = groupScores.get(s.atomicGroupId)!;
      if (s.score > STAGE_FULL) s.stage = "FULL";
      else if (s.score >= STAGE_COMPRESSED) s.stage = "COMPRESSED";
      else s.stage = "DROPPED";
    }
  }

  return scored;
}

// ── Message Compression (Stage 2) ──────────────────────────────────

/**
 * Compress a message to ~20% of tokens.
 * Preserves key facts: exit codes, file paths, error messages, decisions.
 */
export function compressMessage(msg: Message): Message {
  const content = msg.content || "";
  if (!content || content.length < 200) return msg; // Too small to compress

  if (msg.role === "tool") {
    return { ...msg, content: compressToolOutput(content) };
  }

  if (msg.role === "assistant") {
    // Preserve tool_calls intact, only compress text content
    if (msg.tool_calls && msg.tool_calls.length > 0) {
      return {
        ...msg,
        content:
          content.length > 500
            ? smartTruncate(content, { maxLength: Math.max(100, Math.floor(content.length * 0.2)) })
            : content,
      };
    }
    return { ...msg, content: smartTruncate(content, { maxLength: Math.max(200, Math.floor(content.length * 0.2)) }) };
  }

  if (msg.role === "user") {
    return { ...msg, content: smartTruncate(content, { maxLength: Math.max(200, Math.floor(content.length * 0.3)) }) };
  }

  return msg;
}

function compressToolOutput(content: string): string {
  const lines = content.split("\n");
  const kept: string[] = [];

  // Keep first 3 lines (usually the command or header)
  kept.push(...lines.slice(0, 3));

  // Keep error lines
  for (const line of lines) {
    if (/error|fail|warn|exception|panic|traceback/i.test(line) && !kept.includes(line)) {
      kept.push(line);
    }
  }

  // Keep exit code line
  const exitLine = lines.find((l) => /exit\s*(code|status)/i.test(l));
  if (exitLine && !kept.includes(exitLine)) kept.push(exitLine);

  // Keep file path lines
  for (const line of lines) {
    if (/^[\/\.].*\.(ts|js|py|go|rs|json|yaml|yml|md|txt)/.test(line.trim()) && !kept.includes(line)) {
      kept.push(line);
      if (kept.length > 20) break;
    }
  }

  // Keep last 2 lines (often summary)
  kept.push(...lines.slice(-2).filter((l) => !kept.includes(l)));

  const compressed = kept.join("\n");
  if (compressed.length < content.length * 0.5) {
    return compressed + `\n[Compressed from ${content.length} chars]`;
  }

  // Fallback: smart truncate to 20%
  return smartTruncate(content, { maxLength: Math.max(200, Math.floor(content.length * 0.2)) });
}

// ── Budget Demotion ────────────────────────────────────────────────

/**
 * Demote messages to fit within token budget.
 * Returns messages with updated stages.
 */
export function fitToBudget(scored: ScoredMessage[], tokenBudget: number): ScoredMessage[] {
  // Build set of atomic group IDs that contain anchors (C24: never split atomic pairs)
  const anchorGroups = new Set<string>();
  for (const s of scored) {
    if (s.isAnchor && s.atomicGroupId) {
      anchorGroups.add(s.atomicGroupId);
    }
  }

  // Calculate current FULL tokens
  let fullTokens = 0;
  const fullMessages = scored.filter((s) => s.stage === "FULL" || s.isAnchor);
  for (const s of fullMessages) {
    fullTokens += estimateTokens(s.message.content || "");
    if (s.message.tool_calls) fullTokens += estimateTokens(JSON.stringify(s.message.tool_calls));
  }

  if (fullTokens <= tokenBudget) return scored;

  // Sort FULL by score ascending (lowest first for demotion)
  // Skip anchors AND members of anchor groups (C24)
  const demotable = scored
    .filter((s) => s.stage === "FULL" && !s.isAnchor && !(s.atomicGroupId && anchorGroups.has(s.atomicGroupId)))
    .sort((a, b) => a.score - b.score);

  for (const s of demotable) {
    if (fullTokens <= tokenBudget) break;
    // Demote entire atomic group together (C24)
    if (s.atomicGroupId) {
      const groupMembers = scored.filter((g) => g.atomicGroupId === s.atomicGroupId && g.stage === "FULL");
      for (const gm of groupMembers) {
        const tokens = estimateTokens(gm.message.content || "");
        gm.stage = "COMPRESSED";
        fullTokens -= tokens;
        fullTokens += Math.ceil(tokens * 0.2);
      }
    } else {
      const tokens = estimateTokens(s.message.content || "");
      s.stage = "COMPRESSED";
      fullTokens -= tokens;
      fullTokens += Math.ceil(tokens * 0.2);
    }
  }

  // If still over budget, demote COMPRESSED to DROPPED
  if (fullTokens > tokenBudget) {
    const compressedDemotable = scored
      .filter((s) => s.stage === "COMPRESSED" && !s.isAnchor && !(s.atomicGroupId && anchorGroups.has(s.atomicGroupId)))
      .sort((a, b) => a.score - b.score);

    for (const s of compressedDemotable) {
      if (fullTokens <= tokenBudget) break;
      if (s.atomicGroupId) {
        const groupMembers = scored.filter((g) => g.atomicGroupId === s.atomicGroupId && g.stage === "COMPRESSED");
        for (const gm of groupMembers) {
          const tokens = estimateTokens(gm.message.content || "") * 0.2;
          gm.stage = "DROPPED";
          fullTokens -= tokens;
        }
      } else {
        const tokens = estimateTokens(s.message.content || "") * 0.2;
        s.stage = "DROPPED";
        fullTokens -= tokens;
      }
    }
  }

  return scored;
}

// ── Atomic Groups ──────────────────────────────────────────────────

function buildAtomicGroups(messages: Message[]): Map<number, string> {
  const groups = new Map<number, string>();
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (msg.role === "assistant" && msg.tool_calls && msg.tool_calls.length > 0) {
      const groupId = `group-${i}`;
      groups.set(i, groupId);
      // Find corresponding tool results by tool_call_id OR by position
      const callIds = new Set(msg.tool_calls.map((tc: any) => tc.id).filter(Boolean));
      for (let j = i + 1; j < messages.length; j++) {
        if (messages[j].role === "tool") {
          // Match by tool_call_id if available, or by position (tool following assistant)
          if (!messages[j].tool_call_id || callIds.has(messages[j].tool_call_id!)) {
            groups.set(j, groupId);
          }
        }
        // Stop at next non-tool message (except tool results)
        if (messages[j].role !== "tool" && j > i) break;
      }
    }
  }
  return groups;
}

// ── Heuristic Detectors ────────────────────────────────────────────

function extractKeyTerms(text: string): string[] {
  // Limit scan to first 2000 chars to avoid slow regex on large tool outputs
  const sample = text.length > 2000 ? text.slice(0, 2000) : text;
  const terms: string[] = [];
  // File paths
  const paths = sample.match(/[\w/.-]+\.(ts|js|py|go|rs|json|yaml|md)/g);
  if (paths) terms.push(...paths.slice(0, 3));
  // Function names
  const funcs = sample.match(/(?:function|def|fn|func)\s+(\w+)/g);
  if (funcs) terms.push(...funcs.slice(0, 2));
  return terms;
}

function isTaskDefinition(content: string): boolean {
  if (content.length < 20) return false;
  return /(?:please|want|need|should|must|implement|create|build|fix|add|update|deploy|set up)/i.test(content);
}

function containsDecision(content: string): boolean {
  return /(?:I (?:chose|decided|picked|selected)|because|reason(?:ing)?|trade-?off|over .+ because)/i.test(content);
}

function containsErrorResolution(content: string): boolean {
  return /(?:fixed|resolved|solution|workaround|the (?:issue|bug|error) was)/i.test(content);
}

function containsPlanUpdate(content: string): boolean {
  return /(?:step \d|phase \d|next:|plan:|todo:|task \d|\[x\]|\[ \])/i.test(content);
}

function isAcknowledgment(content: string): boolean {
  if (content.length > 100) return false;
  return /^(?:ok|sure|got it|understood|will do|sounds good|yes|alright|thanks)/i.test(content.trim());
}

function isUnresolvedError(content: string): boolean {
  return (
    /(?:error|exception|fail|panic|ENOENT|EACCES|EPERM|crash)/i.test(content) &&
    !/(?:fixed|resolved|solution)/i.test(content)
  );
}

function isErrorContent(content: string): boolean {
  return /(?:error|fail|exception|exit code [1-9]|non-zero|ENOENT|EACCES|panic|traceback)/i.test(content);
}

// ── Role Alternation Repair ────────────────────────────────────────

/**
 * Repair role alternation after non-contiguous selection.
 * Ensures no consecutive same-role messages (Anthropic requirement).
 */
export function repairRoleAlternation(messages: Message[]): Message[] {
  if (messages.length <= 1) return messages;

  const repaired: Message[] = [messages[0]];
  for (let i = 1; i < messages.length; i++) {
    const prev = repaired[repaired.length - 1];
    const curr = messages[i];

    // Tool messages can follow assistant (with tool_calls) or other tool messages
    if (curr.role === "tool") {
      if (prev.role === "assistant" || prev.role === "tool") {
        repaired.push(curr);
        continue;
      }
      // Tool after non-assistant (e.g., after compaction removed assistant) — insert synthetic assistant
      repaired.push({ role: "assistant", content: "[tool calls]" });
      repaired.push(curr);
      continue;
    }

    // Consecutive same-role (non-tool): insert synthetic gap
    if (curr.role === prev.role && curr.role !== "tool") {
      if (curr.role === "user") {
        repaired.push({ role: "assistant", content: "[continued]" });
      } else {
        repaired.push({ role: "user", content: "[continued]" });
      }
    }

    repaired.push(curr);
  }

  return repaired;
}
