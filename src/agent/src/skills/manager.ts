/**
 * Skill System - Lazy-loaded skills with semantic matching
 *
 * Skills are stored as markdown files with YAML frontmatter in ~/.clawd/skills/
 * They are indexed with keyword-based matching for efficient retrieval.
 */

import Database from "bun:sqlite";
import { readFileSync, readdirSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

// ============================================================================
// Types
// ============================================================================

export interface SkillMetadata {
  name: string;
  description: string;
  triggers: string[]; // Keywords that activate this skill
  version?: string;
  author?: string;
}

export interface Skill extends SkillMetadata {
  content: string; // Full skill content (markdown)
  path: string; // File path
  tokens?: number; // Estimated token count
}

export interface SkillMatch {
  skill: SkillMetadata;
  score: number; // 0-1 relevance score
  matchedTriggers: string[];
}

// ============================================================================
// YAML Frontmatter Parser (simple)
// ============================================================================

function parseFrontmatter(content: string): { metadata: Record<string, any>; body: string } {
  const match = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!match) {
    return { metadata: {}, body: content };
  }

  const [, yaml, body] = match;
  const metadata: Record<string, any> = {};

  // Simple YAML parser for our use case
  for (const line of yaml.split("\n")) {
    const colonIdx = line.indexOf(":");
    if (colonIdx === -1) continue;

    const key = line.slice(0, colonIdx).trim();
    let value = line.slice(colonIdx + 1).trim();

    // Handle arrays like [a, b, c]
    if (value.startsWith("[") && value.endsWith("]")) {
      value = value
        .slice(1, -1)
        .split(",")
        .map((s) => s.trim()) as any;
    }

    metadata[key] = value;
  }

  return { metadata, body };
}

// ============================================================================
// Skill Manager
// ============================================================================

export class SkillManager {
  private db: Database;
  private skillsDir: string;
  private cache = new Map<string, Skill>();

  constructor(skillsDir?: string) {
    this.skillsDir = skillsDir || join(homedir(), ".clawd", "skills");

    // Ensure directory exists
    if (!existsSync(this.skillsDir)) {
      mkdirSync(this.skillsDir, { recursive: true });
    }

    // Initialize database
    const dbPath = join(this.skillsDir, "index.db");
    this.db = new Database(dbPath);
    this.setupConcurrency();
    this.initDb();
  }

  private setupConcurrency() {
    // Enable WAL mode for better concurrent access
    this.db.exec("PRAGMA journal_mode = WAL");
    // Wait up to 30 seconds for locks (increased from 5s)
    this.db.exec("PRAGMA busy_timeout = 30000");
    // Balanced sync mode
    this.db.exec("PRAGMA synchronous = NORMAL");
    // Increase cache size
    this.db.exec("PRAGMA cache_size = -16000"); // 16MB cache
  }

  private initDb() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS skills (
        name TEXT PRIMARY KEY,
        description TEXT,
        path TEXT,
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
  // Index Skills
  // ============================================================================

  async indexSkills(): Promise<number> {
    const files = readdirSync(this.skillsDir).filter((f) => f.endsWith(".md"));
    let indexed = 0;

    for (const file of files) {
      const path = join(this.skillsDir, file);
      const content = readFileSync(path, "utf-8");
      const { metadata, body } = parseFrontmatter(content);

      if (!metadata.name) {
        metadata.name = file.replace(".md", "");
      }

      const tokens = Math.ceil(body.length / 4);

      // Update database
      this.db.run(
        `
        INSERT OR REPLACE INTO skills (name, description, path, tokens, updated_at)
        VALUES (?, ?, ?, ?, ?)
      `,
        [metadata.name, metadata.description || "", path, tokens, Date.now()],
      );

      // Update triggers
      this.db.run("DELETE FROM triggers WHERE skill_name = ?", [metadata.name]);

      const triggers = Array.isArray(metadata.triggers) ? metadata.triggers : [];
      for (const trigger of triggers) {
        this.db.run("INSERT OR IGNORE INTO triggers (skill_name, trigger) VALUES (?, ?)", [
          metadata.name,
          trigger.toLowerCase(),
        ]);
      }

      indexed++;
    }

    return indexed;
  }

  // ============================================================================
  // List Skills (lightweight - for context)
  // ============================================================================

  listSkills(): SkillMetadata[] {
    const rows = this.db
      .query(`
      SELECT s.name, s.description, GROUP_CONCAT(t.trigger) as triggers
      FROM skills s
      LEFT JOIN triggers t ON s.name = t.skill_name
      GROUP BY s.name
    `)
      .all() as any[];

    return rows.map((row) => ({
      name: row.name,
      description: row.description,
      triggers: row.triggers ? row.triggers.split(",") : [],
    }));
  }

  // ============================================================================
  // Search Skills by Keywords
  // ============================================================================

  searchByKeywords(keywords: string[]): SkillMatch[] {
    const normalizedKeywords = keywords.map((k) => k.toLowerCase());
    const matches = new Map<string, { score: number; matchedTriggers: string[] }>();

    for (const keyword of normalizedKeywords) {
      // Exact trigger match
      const exactRows = this.db
        .query("SELECT skill_name, trigger FROM triggers WHERE trigger = ?")
        .all(keyword) as any[];

      for (const row of exactRows) {
        const existing = matches.get(row.skill_name) || { score: 0, matchedTriggers: [] };
        existing.score += 1.0;
        existing.matchedTriggers.push(row.trigger);
        matches.set(row.skill_name, existing);
      }

      // Partial trigger match
      const partialRows = this.db
        .query("SELECT skill_name, trigger FROM triggers WHERE trigger LIKE ?")
        .all(`%${keyword}%`) as any[];

      for (const row of partialRows) {
        if (row.trigger === keyword) continue; // Already counted
        const existing = matches.get(row.skill_name) || { score: 0, matchedTriggers: [] };
        existing.score += 0.5;
        if (!existing.matchedTriggers.includes(row.trigger)) {
          existing.matchedTriggers.push(row.trigger);
        }
        matches.set(row.skill_name, existing);
      }

      // Description match
      const descRows = this.db.query("SELECT name FROM skills WHERE description LIKE ?").all(`%${keyword}%`) as any[];

      for (const row of descRows) {
        const existing = matches.get(row.name) || { score: 0, matchedTriggers: [] };
        existing.score += 0.3;
        matches.set(row.name, existing);
      }
    }

    // Convert to SkillMatch array
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
  // Match Skills for Message (semantic-ish matching)
  // ============================================================================

  matchForMessage(message: string, maxSkills = 3): SkillMatch[] {
    // Extract keywords from message
    const words = message
      .toLowerCase()
      .replace(/[^\w\s]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length > 2);

    const matches = this.searchByKeywords(words);
    return matches.slice(0, maxSkills);
  }

  // ============================================================================
  // Get Full Skill Content
  // ============================================================================

  getSkill(name: string): Skill | null {
    // Check cache
    if (this.cache.has(name)) {
      return this.cache.get(name)!;
    }

    const row = this.db.query("SELECT name, description, path, tokens FROM skills WHERE name = ?").get(name) as any;

    if (!row) return null;

    const content = readFileSync(row.path, "utf-8");
    const { metadata, body } = parseFrontmatter(content);

    const skill: Skill = {
      name: row.name,
      description: row.description,
      triggers: Array.isArray(metadata.triggers) ? metadata.triggers : [],
      content: body,
      path: row.path,
      tokens: row.tokens,
    };

    this.cache.set(name, skill);
    return skill;
  }

  // ============================================================================
  // Create/Update Skill
  // ============================================================================

  saveSkill(skill: Omit<Skill, "path" | "tokens">): void {
    const path = join(this.skillsDir, `${skill.name}.md`);

    const frontmatter = [
      "---",
      `name: ${skill.name}`,
      `description: ${skill.description}`,
      `triggers: [${skill.triggers.join(", ")}]`,
      "---",
      "",
      skill.content,
    ].join("\n");

    writeFileSync(path, frontmatter);
    this.cache.delete(skill.name);

    // Re-index this skill
    this.indexSkills();
  }

  // ============================================================================
  // Delete Skill
  // ============================================================================

  deleteSkill(name: string): boolean {
    const row = this.db.query("SELECT path FROM skills WHERE name = ?").get(name) as any;
    if (!row) return false;

    const { unlinkSync } = require("node:fs");
    try {
      unlinkSync(row.path);
    } catch {}

    this.db.run("DELETE FROM skills WHERE name = ?", [name]);
    this.db.run("DELETE FROM triggers WHERE skill_name = ?", [name]);
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
      lines.push(`- **${skill.name}**: ${skill.description}`);
    }
    lines.push("");
    lines.push("Use `skill_activate` tool to load a skill when needed.");

    return lines.join("\n");
  }

  close() {
    this.db.close();
  }
}

// Singleton
let _skillManager: SkillManager | null = null;

export function getSkillManager(): SkillManager {
  if (!_skillManager) {
    _skillManager = new SkillManager();
  }
  return _skillManager;
}
