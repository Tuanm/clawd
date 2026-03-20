/**
 * Skill System - Multi-source skills with Claude Code-compatible format
 *
 * Skills are loaded from four directories (higher priority overrides lower):
 *   1. {projectRoot}/.clawd/skills/{name}/SKILL.md   (project Claw'd — highest priority)
 *   2. {projectRoot}/.claude/skills/{name}/SKILL.md   (project Claude Code)
 *   3. ~/.clawd/skills/{name}/SKILL.md                (global Claw'd)
 *   4. ~/.claude/skills/{name}/SKILL.md                (global Claude Code — lowest priority)
 *   Legacy: ~/.clawd/skills/{name}.md                  (global, single-file)
 *
 * SKILL.md format:
 *   ---
 *   name: skill-name
 *   description: Brief description (<200 chars)
 *   triggers: [keyword1, keyword2]
 *   version: 1.0.0           (optional)
 *   argument-hint: "[args]"  (optional)
 *   allowed-tools: [bash, view] (optional)
 *   ---
 *   # Markdown instructions...
 *
 * Skills are indexed in a cache DB at ~/.clawd/cache/skills/{projectHash}/index.db
 * for efficient keyword-based matching.
 */

import Database from "bun:sqlite";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { getContextProjectRoot } from "../utils/agent-context";

// ============================================================================
// Types
// ============================================================================

export interface SkillMetadata {
  name: string;
  description: string;
  triggers: string[];
  version?: string;
  author?: string;
  argumentHint?: string;
  allowedTools?: string[];
  source: "project" | "global";
}

export interface Skill extends SkillMetadata {
  content: string;
  path: string;
  tokens?: number;
}

export interface SkillMatch {
  skill: SkillMetadata;
  score: number;
  matchedTriggers: string[];
}

// ============================================================================
// YAML Frontmatter Parser (simple)
// ============================================================================

function parseFrontmatter(content: string): { metadata: Record<string, any>; body: string } {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) {
    return { metadata: {}, body: content };
  }

  const [, yaml, body] = match;
  const metadata: Record<string, any> = {};

  for (const line of yaml.split(/\r?\n/)) {
    const colonIdx = line.indexOf(":");
    if (colonIdx === -1) continue;

    const key = line.slice(0, colonIdx).trim();
    let value = line.slice(colonIdx + 1).trim();

    // Handle arrays like [a, b, c]
    if (value.startsWith("[") && value.endsWith("]")) {
      value = value
        .slice(1, -1)
        .split(",")
        .map((s: string) => s.trim())
        .filter((s: string) => s.length > 0) as any;
    }

    metadata[key] = value;
  }

  return { metadata, body };
}

/** Validate skill name: lowercase, no spaces, safe for filesystem */
const SKILL_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;

// ============================================================================
// Skill Manager — Dual-source (project + global)
// ============================================================================

export class SkillManager {
  private db: Database;
  /** Skill directories in priority order (highest first). Later entries override earlier by name. */
  private skillDirs: Array<{ path: string; source: "project" | "global" }>;
  /** Primary project skills dir (for save/delete operations) */
  private projectSkillsDir: string | null;
  private globalSkillsDir: string;
  private cache = new Map<string, Skill>();
  private lastIndexedAt = 0;
  private static INDEX_COOLDOWN_MS = 5_000; // 5 seconds

  constructor(projectRoot?: string) {
    this.globalSkillsDir = join(homedir(), ".clawd", "skills");
    this.projectSkillsDir = projectRoot ? join(projectRoot, ".clawd", "skills") : null;

    // Build skill directories in indexing order (lowest priority first, highest last).
    // Later entries override earlier ones via INSERT OR REPLACE in SQLite.
    this.skillDirs = [
      { path: join(homedir(), ".claude", "skills"), source: "global" as const }, // Claude Code global
      { path: join(homedir(), ".clawd", "skills"), source: "global" as const }, // Claw'd global
    ];
    if (projectRoot) {
      this.skillDirs.push(
        { path: join(projectRoot, ".claude", "skills"), source: "project" as const }, // Claude Code project
        { path: join(projectRoot, ".clawd", "skills"), source: "project" as const }, // Claw'd project (highest)
      );
    }

    // Ensure global dir exists
    if (!existsSync(this.globalSkillsDir)) {
      mkdirSync(this.globalSkillsDir, { recursive: true });
    }

    // Cache DB lives outside .clawd/ (not inside project or skills dir)
    const hash = projectRoot ? createHash("sha256").update(projectRoot).digest("hex").slice(0, 12) : "global";
    const cacheDir = join(homedir(), ".clawd", "cache", "skills", hash);
    if (!existsSync(cacheDir)) mkdirSync(cacheDir, { recursive: true });

    this.db = new Database(join(cacheDir, "index.db"));
    this.setupConcurrency();
    this.initDb();
  }

  private setupConcurrency() {
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA busy_timeout = 30000");
    this.db.exec("PRAGMA synchronous = NORMAL");
    this.db.exec("PRAGMA cache_size = -8000");
    this.db.exec("PRAGMA foreign_keys = ON");
  }

  private initDb() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS skills (
        name TEXT PRIMARY KEY,
        description TEXT,
        path TEXT,
        source TEXT DEFAULT 'global',
        tokens INTEGER,
        updated_at INTEGER
      );

      CREATE TABLE IF NOT EXISTS triggers (
        skill_name TEXT,
        trigger TEXT,
        PRIMARY KEY (skill_name, trigger),
        FOREIGN KEY (skill_name) REFERENCES skills(name) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_triggers_trigger ON triggers(trigger);
    `);
  }

  // ============================================================================
  // Index Skills — scans both project and global directories
  // ============================================================================

  indexSkills(): number {
    // Clear and rebuild
    this.db.run("DELETE FROM triggers");
    this.db.run("DELETE FROM skills");
    this.cache.clear();

    let indexed = 0;

    // Index all skill directories in priority order (lowest first).
    // Later directories override earlier ones by name via INSERT OR REPLACE.
    for (const { path, source } of this.skillDirs) {
      if (existsSync(path)) {
        indexed += this.indexDirectory(path, source);
      }
    }

    this.lastIndexedAt = Date.now();
    return indexed;
  }

  /** Index only if the cooldown has elapsed. Returns -1 if skipped. */
  indexSkillsIfStale(): number {
    if (Date.now() - this.lastIndexedAt < SkillManager.INDEX_COOLDOWN_MS) return -1;
    return this.indexSkills();
  }

  /** Index a single skill by name (efficient re-index after save) */
  private indexSingleSkill(name: string, skillPath: string, source: "project" | "global"): void {
    const content = readFileSync(skillPath, "utf-8");
    const { metadata, body } = parseFrontmatter(content);
    const tokens = Math.ceil(body.length / 4);

    this.db.run(
      "INSERT OR REPLACE INTO skills (name, description, path, source, tokens, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
      [name, metadata.description || "", skillPath, source, tokens, Date.now()],
    );

    this.db.run("DELETE FROM triggers WHERE skill_name = ?", [name]);

    const triggers = Array.isArray(metadata.triggers) ? metadata.triggers : [];
    for (const trigger of triggers) {
      if (typeof trigger === "string" && trigger.length > 0) {
        this.db.run("INSERT OR IGNORE INTO triggers (skill_name, trigger) VALUES (?, ?)", [
          name,
          trigger.toLowerCase(),
        ]);
      }
    }

    this.cache.delete(name);
  }

  private indexDirectory(dir: string, source: "project" | "global"): number {
    if (!existsSync(dir)) return 0;
    let indexed = 0;

    const entries = readdirSync(dir);
    for (const entry of entries) {
      const entryPath = join(dir, entry);
      const stat = statSync(entryPath);

      if (stat.isDirectory()) {
        // Folder format: {name}/SKILL.md
        const skillMdPath = join(entryPath, "SKILL.md");
        if (existsSync(skillMdPath)) {
          const name = entry;
          this.indexSingleSkill(name, skillMdPath, source);
          indexed++;
        }
      } else if (entry.endsWith(".md") && entry !== "README.md") {
        // Legacy single-file format: {name}.md
        const name = entry.replace(/\.md$/, "");
        this.indexSingleSkill(name, entryPath, source);
        indexed++;
      }
    }

    return indexed;
  }

  // ============================================================================
  // List Skills
  // ============================================================================

  listSkills(): SkillMetadata[] {
    const rows = this.db
      .query(
        `SELECT s.name, s.description, s.source, GROUP_CONCAT(t.trigger) as triggers
         FROM skills s
         LEFT JOIN triggers t ON s.name = t.skill_name
         GROUP BY s.name`,
      )
      .all() as any[];

    return rows.map((row) => ({
      name: row.name,
      description: row.description,
      triggers: row.triggers ? row.triggers.split(",") : [],
      source: row.source as "project" | "global",
    }));
  }

  // ============================================================================
  // Search Skills by Keywords
  // ============================================================================

  searchByKeywords(keywords: string[]): SkillMatch[] {
    const normalizedKeywords = keywords.map((k) => k.toLowerCase());
    const matches = new Map<string, { score: number; matchedTriggers: string[] }>();

    for (const keyword of normalizedKeywords) {
      const exactRows = this.db
        .query("SELECT skill_name, trigger FROM triggers WHERE trigger = ?")
        .all(keyword) as any[];

      for (const row of exactRows) {
        const existing = matches.get(row.skill_name) || { score: 0, matchedTriggers: [] };
        existing.score += 1.0;
        existing.matchedTriggers.push(row.trigger);
        matches.set(row.skill_name, existing);
      }

      const partialRows = this.db
        .query("SELECT skill_name, trigger FROM triggers WHERE trigger LIKE ?")
        .all(`%${keyword}%`) as any[];

      for (const row of partialRows) {
        if (row.trigger === keyword) continue;
        const existing = matches.get(row.skill_name) || { score: 0, matchedTriggers: [] };
        existing.score += 0.5;
        if (!existing.matchedTriggers.includes(row.trigger)) {
          existing.matchedTriggers.push(row.trigger);
        }
        matches.set(row.skill_name, existing);
      }

      const descRows = this.db.query("SELECT name FROM skills WHERE description LIKE ?").all(`%${keyword}%`) as any[];

      for (const row of descRows) {
        const existing = matches.get(row.name) || { score: 0, matchedTriggers: [] };
        existing.score += 0.3;
        matches.set(row.name, existing);
      }
    }

    const skills = this.listSkills();
    const skillMap = new Map(skills.map((s) => [s.name, s]));

    const results: SkillMatch[] = [];
    for (const [name, match] of matches) {
      const skill = skillMap.get(name);
      if (skill) {
        results.push({
          skill,
          score: Math.min(1, match.score / keywords.length),
          matchedTriggers: match.matchedTriggers,
        });
      }
    }

    return results.sort((a, b) => b.score - a.score);
  }

  // ============================================================================
  // Match Skills for Message
  // ============================================================================

  matchForMessage(message: string, maxSkills = 3): SkillMatch[] {
    const words = message
      .toLowerCase()
      .replace(/[^\w\s]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length > 2);

    return this.searchByKeywords(words).slice(0, maxSkills);
  }

  // ============================================================================
  // Get Full Skill Content
  // ============================================================================

  getSkill(name: string): Skill | null {
    if (this.cache.has(name)) return this.cache.get(name)!;

    const row = this.db
      .query("SELECT name, description, path, source, tokens FROM skills WHERE name = ?")
      .get(name) as any;

    if (!row || !existsSync(row.path)) return null;

    const content = readFileSync(row.path, "utf-8");
    const { metadata, body } = parseFrontmatter(content);

    const skill: Skill = {
      name: row.name,
      description: row.description,
      triggers: Array.isArray(metadata.triggers) ? metadata.triggers : [],
      content: body,
      path: row.path,
      tokens: row.tokens,
      source: row.source,
      version: metadata.version,
      argumentHint: metadata["argument-hint"],
      allowedTools: Array.isArray(metadata["allowed-tools"]) ? metadata["allowed-tools"] : undefined,
    };

    this.cache.set(name, skill);
    return skill;
  }

  // ============================================================================
  // Create/Update Skill — saves to project or global dir (folder format)
  // ============================================================================

  saveSkill(
    skill: Omit<Skill, "path" | "tokens" | "source">,
    scope: "project" | "global" = "project",
  ): { success: boolean; error?: string } {
    if (!SKILL_NAME_RE.test(skill.name)) {
      return {
        success: false,
        error: `Invalid skill name '${skill.name}'. Use lowercase a-z, 0-9, hyphens, underscores (max 64 chars).`,
      };
    }

    const targetDir = scope === "project" ? this.projectSkillsDir : this.globalSkillsDir;
    if (!targetDir) {
      return { success: false, error: "No project root configured; cannot save project skill." };
    }

    const skillDir = join(targetDir, skill.name);
    if (!existsSync(skillDir)) mkdirSync(skillDir, { recursive: true });

    const skillPath = join(skillDir, "SKILL.md");

    const lines = [
      "---",
      `name: ${skill.name}`,
      `description: ${skill.description}`,
      `triggers: [${skill.triggers.join(", ")}]`,
    ];
    if (skill.version) lines.push(`version: ${skill.version}`);
    if (skill.argumentHint) lines.push(`argument-hint: ${skill.argumentHint}`);
    if (skill.allowedTools?.length) lines.push(`allowed-tools: [${skill.allowedTools.join(", ")}]`);
    lines.push("---", "", skill.content);

    writeFileSync(skillPath, lines.join("\n"));
    this.indexSingleSkill(skill.name, skillPath, scope);

    return { success: true };
  }

  // ============================================================================
  // Delete Skill
  // ============================================================================

  deleteSkill(name: string): boolean {
    if (!SKILL_NAME_RE.test(name)) return false;

    const row = this.db.query("SELECT path, source FROM skills WHERE name = ?").get(name) as any;
    if (!row) return false;

    try {
      const skillPath = row.path as string;
      const parentDir = join(skillPath, "..");
      const parentName = basename(parentDir);

      // Folder format: parent dir contains SKILL.md AND parent name matches skill name
      if (basename(skillPath) === "SKILL.md" && parentName === name) {
        rmSync(parentDir, { recursive: true, force: true });
      } else {
        // Legacy single-file
        unlinkSync(skillPath);
      }
    } catch (err) {
      console.warn(`[SkillManager] Failed to delete skill files for '${name}':`, err);
      return false;
    }

    this.db.run("DELETE FROM triggers WHERE skill_name = ?", [name]);
    this.db.run("DELETE FROM skills WHERE name = ?", [name]);
    this.cache.delete(name);

    return true;
  }

  // ============================================================================
  // Get Skills Summary for System Prompt
  // ============================================================================

  getSkillsSummary(): string {
    const skills = this.listSkills();
    if (skills.length === 0) return "";

    const lines = ["## Available Skills", ""];
    for (const skill of skills) {
      const tag = skill.source === "project" ? "(project)" : "(global)";
      lines.push(`- **${skill.name}** ${tag}: ${skill.description}`);
    }
    lines.push("");
    lines.push("Use `skill_activate` tool to load a skill when needed.");

    return lines.join("\n");
  }

  close() {
    try {
      this.db.close();
    } catch {}
  }
}

// ============================================================================
// Per-project instances (keyed by project root)
// ============================================================================

const _managers = new Map<string, SkillManager>();

export function getSkillManager(projectRoot?: string): SkillManager {
  // Use original project root for skills (not worktree path)
  const { getContextConfigRoot } = require("../utils/agent-context");
  const root = projectRoot || getContextConfigRoot();
  const key = root || "__global__";

  if (!_managers.has(key)) {
    _managers.set(key, new SkillManager(root || undefined));
  }
  return _managers.get(key)!;
}

/** Close all skill manager DB handles. Call on process shutdown. */
export function closeAllSkillManagers(): void {
  for (const [, manager] of _managers) {
    manager.close();
  }
  _managers.clear();
}
