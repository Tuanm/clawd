/**
 * CC State Persistence — structured session state for Claude Code agents.
 *
 * Mirrors the state-persistence-plugin used by standard agents, providing:
 * - Inception: immutable task description (captured from first user message)
 * - File tracking: read/created/modified/deleted files
 * - Decision logging: what was decided and why
 * - Error tracking: errors encountered and resolutions
 * - Plan progress: step-by-step task tracking
 *
 * Persisted to ~/.clawd/sessions/{sessionId}/working-state.json
 * with atomic writes (tmp + rename) for crash safety.
 *
 * Injected into CC system prompt via formatForContext() to provide
 * continuity after session compaction.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

// ── Types ──────────────────────────────────────────────────────────────────

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
  /** Tool call history that survives compaction — extracted from session rows
   *  before they are summarized/deleted. Each entry is a condensed record of
   *  a tool invocation: tool name, key args (path/file), and timestamp. */
  toolCallLog: Array<{
    tool: string;
    args: string;
    ts: string;
  }>;
}

// ── Constants ───────────────────────────────────────────────────────────────

const FILES_CAP = 200;
const DECISIONS_CAP = 50;
const FORMAT_CAP_CHARS = 7000; // ~2K tokens max for system prompt injection

// ── Default State ───────────────────────────────────────────────────────────

export function createEmptyState(): WorkingState {
  return {
    version: 1,
    inception: { taskDescription: "", constraints: [], createdAt: "" },
    files: {},
    decisions: [],
    errors: [],
    environment: { branch: "", workingDir: "" },
    plan: [],
    toolCallLog: [],
  };
}

// ── Persistence ─────────────────────────────────────────────────────────────

export function loadWorkingState(sessionDir: string): WorkingState {
  const filePath = join(sessionDir, "working-state.json");
  const tmpPath = filePath + ".tmp";

  if (existsSync(filePath)) {
    try {
      const data = JSON.parse(readFileSync(filePath, "utf-8"));
      if (data.version === 1) return data;
    } catch {
      // Corrupted — try tmp recovery
    }
  }

  if (existsSync(tmpPath)) {
    try {
      const data = JSON.parse(readFileSync(tmpPath, "utf-8"));
      if (data.version === 1) {
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

  const dir = dirname(filePath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  writeFileSync(tmpPath, JSON.stringify(state, null, 2), "utf-8");
  renameSync(tmpPath, filePath);
}

// ── Mutation Helpers ────────────────────────────────────────────────────────

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
  if (state.decisions.some((d) => d.what === decision.what)) return;
  if (state.decisions.length >= DECISIONS_CAP) return;

  state.decisions.push({
    what: decision.what,
    why: decision.why,
    alternatives: decision.alternatives || [],
  });
}

export function trackError(
  state: WorkingState,
  error: string,
  resolution: string = "",
  status: "resolved" | "unresolved" = "unresolved",
): void {
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

// ── Formatting ──────────────────────────────────────────────────────────────

export function formatForContext(state: WorkingState): string {
  if (!state.inception.taskDescription && Object.keys(state.files).length === 0 && state.decisions.length === 0) {
    return "";
  }

  const parts: string[] = [];
  parts.push("<working_state>");

  if (state.inception.taskDescription) {
    parts.push(`<inception>${state.inception.taskDescription}</inception>`);
    if (state.inception.constraints.length > 0) {
      parts.push(`<constraints>${state.inception.constraints.join("; ")}</constraints>`);
    }
  }

  if (state.environment.branch || state.environment.workingDir) {
    parts.push(`<environment branch="${state.environment.branch}" workingDir="${state.environment.workingDir}" />`);
  }

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

  if (state.decisions.length > 0) {
    const decLines = state.decisions.map((d) => `  - ${d.what} (${d.why})`);
    parts.push(`<decisions>\n${decLines.join("\n")}\n</decisions>`);
  }

  const unresolvedErrors = state.errors.filter((e) => e.status === "unresolved");
  const resolvedErrors = state.errors.filter((e) => e.status === "resolved");
  if (unresolvedErrors.length > 0 || resolvedErrors.length > 0) {
    const errLines: string[] = [];
    for (const e of unresolvedErrors) errLines.push(`  - [unresolved] ${e.error}`);
    for (const e of resolvedErrors.slice(-5)) errLines.push(`  - [resolved] ${e.error} → ${e.resolution}`);
    parts.push(`<errors>\n${errLines.join("\n")}\n</errors>`);
  }

  if (state.plan.length > 0) {
    const planLines = state.plan.map((p) => {
      const marker = p.status === "done" ? "x" : p.status === "in-progress" ? ">" : p.status === "failed" ? "!" : " ";
      return `  [${marker}] ${p.step}`;
    });
    parts.push(`<plan>\n${planLines.join("\n")}\n</plan>`);
  }

  // Tool call log — survives compaction, shows recent tool invocations
  if (state.toolCallLog.length > 0) {
    const logLines = state.toolCallLog.slice(-10).map((e) => `  - ${e.tool}(${e.args})`);
    parts.push(`<tool_history>\n${logLines.join("\n")}\n</tool_history>`);
  }

  parts.push("</working_state>");

  let result = parts.join("\n");
  if (result.length > FORMAT_CAP_CHARS) {
    result = result.slice(0, FORMAT_CAP_CHARS) + "\n  [truncated]...</working_state>";
  }

  return result;
}

// ── CCStatePersistence Class ─────────────────────────────────────────────────

export class CCStatePersistence {
  private state: WorkingState;
  private sessionDir: string;
  private inceptionCaptured = false;
  private saveDebounceTimer: ReturnType<typeof setTimeout> | null = null;
  private toolArgsCache = new Map<string, { name: string; args: any }>();
  private toolArgsCacheSeq = 0;

  constructor(sessionDir: string) {
    this.sessionDir = sessionDir;
    this.state = loadWorkingState(sessionDir);
  }

  /** Capture task inception from first user message */
  captureInception(message: string): void {
    if (this.inceptionCaptured || this.state.inception.taskDescription) return;
    setInception(this.state, message.slice(0, 2000));
    this.inceptionCaptured = true;
    this.immediateSave();
  }

  /** Track environment (branch, working dir) */
  updateEnvironment(branch: string, workingDir: string): void {
    updateEnvironment(this.state, { branch, workingDir });
    this.debouncedSave();
  }

  /** Called before tool execution — cache args for lookup in onToolResult */
  onToolCall(name: string, args: any): void {
    this.toolArgsCacheSeq += 1;
    const callId = `${name}-${this.toolArgsCacheSeq}`;
    this.toolArgsCache.set(callId, { name, args });

    if (this.toolArgsCache.size > 50) {
      const keys = [...this.toolArgsCache.keys()];
      for (let i = 0; i < keys.length - 50; i++) {
        this.toolArgsCache.delete(keys[i]);
      }
    }
  }

  /** Called after tool execution — track files and errors */
  onToolResult(name: string, args: any, result: any): void {
    try {
      const output = typeof result === "string" ? result : result?.output || result?.content || "";
      const isError =
        result?.error || (typeof result === "object" && result?.exitCode !== undefined && result.exitCode !== 0);

      const filePath = this.extractFilePath(name, args);
      if (filePath) {
        const status = this.getFileStatus(name);
        if (status) {
          const summary = this.deriveSummary(name, filePath);
          const lineCount = typeof output === "string" ? (output.match(/\n/g) || []).length + 1 : 0;
          trackFile(this.state, filePath, {
            status,
            summary,
            lineCount: status === "read" ? lineCount : undefined,
            contentHash:
              typeof output === "string" && output.length < 1_000_000
                ? createHash("sha256").update(output).digest("hex").slice(0, 16)
                : undefined,
          });
        }
      }

      if (isError && typeof output === "string") {
        const errorMsg = output.slice(0, 200);
        trackError(this.state, `${name}: ${errorMsg}`);
      }

      this.debouncedSave();
    } catch (err) {
      console.error("[CCStatePersistence] onToolResult error:", err);
    }
  }

  /** Add a decision (e.g., "decided to use X approach") */
  addDecision(what: string, why: string, alternatives: string[] = []): void {
    addDecision(this.state, { what, why, alternatives });
    this.debouncedSave();
  }

  /** Resolve an error */
  resolveError(error: string, resolution: string): void {
    trackError(this.state, error, resolution, "resolved");
    this.debouncedSave();
  }

  /** Add a tool call to the tool call log (survives compaction) */
  addToolCallToLog(tool: string, args: string, ts: string): void {
    // Deduplicate: skip if same tool+args appeared in last 3 entries
    const recent = this.state.toolCallLog.slice(-3);
    if (recent.some((e) => e.tool === tool && e.args === args)) return;

    this.state.toolCallLog.push({ tool, args: args.slice(0, 200), ts });
    // Keep last 50 entries
    if (this.state.toolCallLog.length > 50) {
      this.state.toolCallLog = this.state.toolCallLog.slice(-50);
    }
  }

  /** Update plan progress */
  updatePlanStep(step: string, status: "pending" | "in-progress" | "done" | "failed", outputs: string[] = []): void {
    const existing = this.state.plan.find((p) => p.step === step);
    if (existing) {
      existing.status = status;
      if (outputs.length > 0) existing.outputs.push(...outputs);
    } else {
      this.state.plan.push({ step, status, outputs });
    }
    this.debouncedSave();
  }

  /** Get formatted context for system prompt injection */
  getContext(): string {
    return formatForContext(this.state);
  }

  /** Get raw state (for debugging) */
  getState(): WorkingState {
    return this.state;
  }

  /** Immediate save before compaction */
  saveImmediately(): void {
    if (this.saveDebounceTimer) {
      clearTimeout(this.saveDebounceTimer);
      this.saveDebounceTimer = null;
    }
    try {
      saveWorkingState(this.sessionDir, this.state);
    } catch (err) {
      console.error("[CCStatePersistence] Save error:", err);
    }
  }

  private debouncedSave(): void {
    if (this.saveDebounceTimer) clearTimeout(this.saveDebounceTimer);
    this.saveDebounceTimer = setTimeout(() => {
      try {
        saveWorkingState(this.sessionDir, this.state);
      } catch (err) {
        console.error("[CCStatePersistence] Save error:", err);
      }
    }, 500);
  }

  private immediateSave(): void {
    if (this.saveDebounceTimer) clearTimeout(this.saveDebounceTimer);
    try {
      saveWorkingState(this.sessionDir, this.state);
    } catch (err) {
      console.error("[CCStatePersistence] Save error:", err);
    }
  }

  private extractFilePath(name: string, args: any): string | null {
    if (!args) return null;
    if (typeof args === "string") {
      try {
        args = JSON.parse(args);
      } catch {
        return null;
      }
    }
    return args?.path || args?.file_path || args?.filePath || args?.file || null;
  }

  private getFileStatus(name: string): "read" | "created" | "modified" | "deleted" | null {
    switch (name) {
      case "View":
      case "view":
      case "Read":
      case "read_file":
      case "mcp__clawd__view":
        return "read";
      case "Create":
      case "create":
      case "create_file":
      case "mcp__clawd__create":
        return "created";
      case "Edit":
      case "edit":
      case "edit_file":
      case "write":
      case "Write":
      case "mcp__clawd__edit":
        return "modified";
      case "Bash":
      case "bash":
      case "mcp__clawd__bash":
        return "modified"; // Bash can modify files
      default:
        return null;
    }
  }

  private deriveSummary(name: string, path: string): string {
    const basename = path.split("/").pop() || path;
    switch (name) {
      case "View":
      case "view":
      case "Read":
      case "read_file":
      case "mcp__clawd__view":
        return `Read ${basename}`;
      case "Create":
      case "create":
      case "create_file":
      case "mcp__clawd__create":
        return `Created ${basename}`;
      case "Edit":
      case "edit":
      case "edit_file":
      case "Write":
      case "write":
      case "mcp__clawd__edit":
        return `Modified ${basename}`;
      case "Bash":
      case "bash":
      case "mcp__clawd__bash":
        return `Shell command on ${basename}`;
      default:
        return `${name} on ${basename}`;
    }
  }
}
