/**
 * Working State — structured session state that survives all compactions.
 *
 * Split into two layers:
 * - Inception: Immutable task description + constraints (set once)
 * - Mutable state: files, decisions, errors, plan (auto-updated via hooks)
 *
 * Stored as JSON at ~/.clawd/sessions/{sessionId}/working-state.json
 * with atomic writes (tmp + rename) for crash safety.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "fs";
import { dirname, join } from "path";

// ── Interface ──────────────────────────────────────────────────────

export interface WorkingState {
  version: 1;
  inception: {
    taskDescription: string;
    constraints: string[];
    createdAt: string;
  };
  files: Record<
    string,
    {
      contentHash: string;
      lastSeen: string;
      status: "read" | "created" | "modified" | "deleted";
      summary: string;
      lineCount: number;
    }
  >;
  decisions: Array<{
    what: string;
    why: string;
    alternatives: string[];
  }>;
  errors: Array<{
    error: string;
    resolution: string;
    status: "resolved" | "unresolved";
  }>;
  environment: { branch: string; workingDir: string };
  plan: Array<{
    step: string;
    status: "pending" | "in-progress" | "done" | "failed";
    outputs: string[];
    blockedBy?: string[];
  }>;
}

const FILES_CAP = 200;
const DECISIONS_CAP = 50;
const FORMAT_CAP_CHARS = 7000; // ~2K tokens max for getSystemContext injection

// ── Default State ──────────────────────────────────────────────────

export function createEmptyState(): WorkingState {
  return {
    version: 1,
    inception: { taskDescription: "", constraints: [], createdAt: "" },
    files: {},
    decisions: [],
    errors: [],
    environment: { branch: "", workingDir: "" },
    plan: [],
  };
}

// ── Persistence ────────────────────────────────────────────────────

export function loadWorkingState(sessionDir: string): WorkingState {
  const filePath = join(sessionDir, "working-state.json");
  const tmpPath = filePath + ".tmp";

  // Try primary file first
  if (existsSync(filePath)) {
    try {
      const data = JSON.parse(readFileSync(filePath, "utf-8"));
      if (data.version === 1) return data;
    } catch {
      // Corrupted — try tmp recovery
    }
  }

  // Try tmp recovery
  if (existsSync(tmpPath)) {
    try {
      const data = JSON.parse(readFileSync(tmpPath, "utf-8"));
      if (data.version === 1) {
        // Promote tmp to primary
        renameSync(tmpPath, filePath);
        return data;
      }
    } catch {
      // Both corrupted
    }
  }

  return createEmptyState();
}

export function saveWorkingState(sessionDir: string, state: WorkingState): void {
  const filePath = join(sessionDir, "working-state.json");
  const tmpPath = filePath + ".tmp";

  // Ensure directory exists
  const dir = dirname(filePath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  // Atomic write: write to tmp, rename to primary
  writeFileSync(tmpPath, JSON.stringify(state, null, 2), "utf-8");
  renameSync(tmpPath, filePath);
}

// ── Mutation Helpers ───────────────────────────────────────────────

export function setInception(state: WorkingState, taskDescription: string, constraints: string[] = []): void {
  if (state.inception.taskDescription) return; // Immutable — set once
  state.inception.taskDescription = taskDescription;
  state.inception.constraints = constraints;
  state.inception.createdAt = new Date().toISOString();
}

export function trackFile(
  state: WorkingState,
  path: string,
  info: {
    contentHash?: string;
    status: "read" | "created" | "modified" | "deleted";
    summary?: string;
    lineCount?: number;
  },
): void {
  state.files[path] = {
    contentHash: info.contentHash || state.files[path]?.contentHash || "",
    lastSeen: new Date().toISOString(),
    status: info.status,
    summary: info.summary || state.files[path]?.summary || "",
    lineCount: info.lineCount ?? state.files[path]?.lineCount ?? 0,
  };

  // LRU eviction if over cap
  const paths = Object.keys(state.files);
  if (paths.length > FILES_CAP) {
    const sorted = paths.sort((a, b) => (state.files[a].lastSeen || "").localeCompare(state.files[b].lastSeen || ""));
    const toEvict = sorted.slice(0, paths.length - FILES_CAP);
    for (const p of toEvict) delete state.files[p];
  }
}

export function addDecision(
  state: WorkingState,
  decision: { what: string; why: string; alternatives?: string[] },
): void {
  // Deduplicate by 'what' field
  if (state.decisions.some((d) => d.what === decision.what)) return;

  state.decisions.push({
    what: decision.what,
    why: decision.why,
    alternatives: decision.alternatives || [],
  });

  // C23: decisions are append-only — never remove. Cap only prevents further additions.
  // Once at cap, new decisions still added (push above) but we don't evict old ones.
}

export function trackError(
  state: WorkingState,
  error: string,
  resolution: string = "",
  status: "resolved" | "unresolved" = "unresolved",
): void {
  // Check if this error already exists
  const existing = state.errors.find((e) => e.error === error);
  if (existing) {
    if (resolution) existing.resolution = resolution;
    if (status === "resolved") existing.status = "resolved";
    return;
  }
  state.errors.push({ error, resolution, status });
}

export function updateEnvironment(state: WorkingState, env: Partial<{ branch: string; workingDir: string }>): void {
  if (env.branch) state.environment.branch = env.branch;
  if (env.workingDir) state.environment.workingDir = env.workingDir;
}

// ── Formatting for System Prompt ───────────────────────────────────

export function formatForContext(state: WorkingState): string {
  if (!state.inception.taskDescription && Object.keys(state.files).length === 0 && state.decisions.length === 0) {
    return ""; // Empty state — don't inject anything
  }

  const parts: string[] = [];
  parts.push("<working_state>");

  // Inception (always first)
  if (state.inception.taskDescription) {
    parts.push(`<inception>${state.inception.taskDescription}</inception>`);
    if (state.inception.constraints.length > 0) {
      parts.push(`<constraints>${state.inception.constraints.join("; ")}</constraints>`);
    }
  }

  // Environment
  if (state.environment.branch || state.environment.workingDir) {
    parts.push(`<environment branch="${state.environment.branch}" workingDir="${state.environment.workingDir}" />`);
  }

  // Files (sorted by lastSeen desc, limit to most recent)
  const filePaths = Object.keys(state.files);
  if (filePaths.length > 0) {
    const sorted = filePaths.sort((a, b) =>
      (state.files[b].lastSeen || "").localeCompare(state.files[a].lastSeen || ""),
    );
    const fileLines = sorted.slice(0, 30).map((p) => {
      const f = state.files[p];
      return `  ${p}: ${f.status} (${f.summary || "no summary"})`;
    });
    parts.push(`<files>\n${fileLines.join("\n")}\n</files>`);
  }

  // Decisions (never dropped)
  if (state.decisions.length > 0) {
    const decLines = state.decisions.map((d) => `  - ${d.what} (${d.why})`);
    parts.push(`<decisions>\n${decLines.join("\n")}\n</decisions>`);
  }

  // Errors (unresolved first, then resolved)
  const unresolvedErrors = state.errors.filter((e) => e.status === "unresolved");
  const resolvedErrors = state.errors.filter((e) => e.status === "resolved");
  if (unresolvedErrors.length > 0 || resolvedErrors.length > 0) {
    const errLines: string[] = [];
    for (const e of unresolvedErrors) errLines.push(`  - [unresolved] ${e.error}`);
    // Show only recent resolved errors (last 5)
    for (const e of resolvedErrors.slice(-5)) errLines.push(`  - [resolved] ${e.error} → ${e.resolution}`);
    parts.push(`<errors>\n${errLines.join("\n")}\n</errors>`);
  }

  // Plan
  if (state.plan.length > 0) {
    const planLines = state.plan.map((p) => {
      const marker = p.status === "done" ? "x" : p.status === "in-progress" ? ">" : p.status === "failed" ? "!" : " ";
      return `  [${marker}] ${p.step}`;
    });
    parts.push(`<plan>\n${planLines.join("\n")}\n</plan>`);
  }

  parts.push("</working_state>");

  let result = parts.join("\n");

  // Hard cap at FORMAT_CAP_CHARS (~2K tokens)
  if (result.length > FORMAT_CAP_CHARS) {
    result = trimToFit(state, FORMAT_CAP_CHARS);
  }

  return result;
}

/**
 * Trim working state to fit within char budget.
 * Priority: decisions (never drop) > inception > unresolved errors > files > resolved errors > plan
 */
function trimToFit(state: WorkingState, maxChars: number): string {
  // Build incrementally, never truncate decisions (C23)
  const open = "<working_state>\n";
  const close = "\n</working_state>";
  let budget = maxChars - open.length - close.length;

  const sections: string[] = [];

  // Inception (always keep, highest priority after decisions)
  if (state.inception.taskDescription) {
    const s = `<inception>${state.inception.taskDescription}</inception>`;
    sections.push(s);
    budget -= s.length + 1; // +1 for newline
  }

  // Decisions (NEVER drop — C23, but compress format if too large)
  if (state.decisions.length > 0) {
    let decLines: string[];
    // Full format first: "what (why)"
    decLines = state.decisions.map((d) => `  - ${d.what} (${d.why})`);
    let s = `<decisions>\n${decLines.join("\n")}\n</decisions>`;
    // If decisions alone exceed remaining budget, compress to "what" only
    if (s.length > budget) {
      decLines = state.decisions.map((d) => `  - ${d.what}`);
      s = `<decisions>\n${decLines.join("\n")}\n</decisions>`;
    }
    sections.push(s);
    budget -= s.length + 1;
  }

  // Unresolved errors (add if budget allows)
  const unresolvedErrors = state.errors.filter((e) => e.status === "unresolved");
  if (unresolvedErrors.length > 0 && budget > 100) {
    const errLines = unresolvedErrors.map((e) => `  - [unresolved] ${e.error}`);
    const s = `<errors>\n${errLines.join("\n")}\n</errors>`;
    if (s.length + 1 <= budget) {
      sections.push(s);
      budget -= s.length + 1;
    }
  }

  // Files (only if budget remains)
  const filePaths = Object.keys(state.files);
  if (filePaths.length > 0 && budget > 100) {
    const sorted = filePaths.sort((a, b) =>
      (state.files[b].lastSeen || "").localeCompare(state.files[a].lastSeen || ""),
    );
    const maxFiles = Math.min(sorted.length, 10);
    const fileLines = sorted.slice(0, maxFiles).map((p) => {
      const f = state.files[p];
      return `  ${p}: ${f.status}`;
    });
    const s = `<files>\n${fileLines.join("\n")}\n</files>`;
    if (s.length + 1 <= budget) {
      sections.push(s);
    }
  }

  return open + sections.join("\n") + close;
}
