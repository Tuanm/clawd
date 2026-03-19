#!/usr/bin/env bun
/**
 * Migration Script: agents.json + roles/ → agents/{name}.md
 *
 * Converts the old split agent config format to the new Claude Code-compatible
 * single-file format with YAML frontmatter.
 *
 * Usage:
 *   bun scripts/migrate-agents.ts /path/to/project
 *   bun scripts/migrate-agents.ts .                    # current directory
 *
 * What it does:
 *   1. Reads .clawd/agents.json (if exists)
 *   2. Reads .clawd/roles/*.md (if exists)
 *   3. Merges each agent's JSON config + role content into agents/{name}.md
 *   4. Does NOT delete old files — verify manually, then delete
 *
 * Safe to run multiple times — overwrites existing agent files in .clawd/agents/.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";

const projectRoot = resolve(process.argv[2] || ".");

if (!existsSync(projectRoot)) {
  console.error(`Error: ${projectRoot} does not exist`);
  process.exit(1);
}

const clawdDir = join(projectRoot, ".clawd");
const agentsJsonPath = join(clawdDir, "agents.json");
const rolesDir = join(clawdDir, "roles");
const agentsDir = join(clawdDir, "agents");

// Load agents.json
let agentsConfig: Record<string, any> = {};
if (existsSync(agentsJsonPath)) {
  try {
    agentsConfig = JSON.parse(readFileSync(agentsJsonPath, "utf-8"));
    console.log(`Found agents.json with ${Object.keys(agentsConfig).length} agent(s)`);
  } catch (e) {
    console.error(`Failed to parse agents.json: ${e}`);
    process.exit(1);
  }
} else {
  console.log("No agents.json found");
}

// Find role files
const roleFiles = new Map<string, string>();
if (existsSync(rolesDir)) {
  for (const file of readdirSync(rolesDir)) {
    if (file.endsWith(".md")) {
      const name = basename(file, ".md");
      try {
        roleFiles.set(name, readFileSync(join(rolesDir, file), "utf-8"));
        console.log(`Found role file: roles/${file}`);
      } catch {
        console.warn(`  Warning: Could not read roles/${file}`);
      }
    }
  }
} else {
  console.log("No roles/ directory found");
}

// Merge all agent names
const allAgents = new Set([...Object.keys(agentsConfig), ...roleFiles.keys()]);

if (allAgents.size === 0) {
  console.log("\nNo agents to migrate.");
  process.exit(0);
}

// Create output directory
mkdirSync(agentsDir, { recursive: true });

let migrated = 0;
for (const name of allAgents) {
  const config = agentsConfig[name] || {};
  const roleContent = roleFiles.get(name) || "";

  // Build frontmatter
  const lines = ["---", `name: ${name}`];

  if (config.description) {
    lines.push(`description: ${config.description}`);
  }
  if (config.model) {
    lines.push(`model: ${config.model}`);
  }
  if (config.language) {
    lines.push(`language: ${config.language}`);
  }
  if (Array.isArray(config.directives) && config.directives.length > 0) {
    lines.push("directives:");
    for (const d of config.directives) {
      lines.push(`  - ${d}`);
    }
  }

  lines.push("---");

  // Combine with role content
  const body = roleContent.trim();
  const fileContent = body ? `${lines.join("\n")}\n\n${body}\n` : `${lines.join("\n")}\n`;

  const outPath = join(agentsDir, `${name}.md`);
  writeFileSync(outPath, fileContent, "utf-8");
  console.log(`  ✓ Migrated: ${name} → .clawd/agents/${name}.md`);
  migrated++;
}

console.log(`\nMigration complete: ${migrated} agent(s) written to .clawd/agents/`);
console.log("\nNext steps:");
console.log("  1. Verify the new agent files look correct");
console.log("  2. Test that agents load properly");
console.log("  3. Delete old files:");
console.log("     rm -f .clawd/agents.json");
console.log("     rm -rf .clawd/roles/");
