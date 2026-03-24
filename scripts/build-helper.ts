#!/usr/bin/env bun
/**
 * build-helper.ts — Cross-platform build utilities
 *
 * Replaces Unix-only commands (mkdir -p, cp, rm -rf) in package.json scripts.
 *
 * Usage:
 *   bun run scripts/build-helper.ts mkdirp <dir>
 *   bun run scripts/build-helper.ts cp <src...> <dest>
 *   bun run scripts/build-helper.ts rmrf <paths...>
 *   bun run scripts/build-helper.ts copy-cli   (copies cli.js to dist/server/)
 */

import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";

const [cmd, ...args] = process.argv.slice(2);

switch (cmd) {
  case "mkdirp":
    for (const dir of args) mkdirSync(resolve(dir), { recursive: true });
    break;

  case "cp": {
    const dest = resolve(args.pop()!);
    for (const src of args) {
      const srcPath = resolve(src);
      if (!existsSync(srcPath)) {
        console.warn(`[build-helper] cp: ${src} not found, skipping`);
        continue;
      }
      const destPath =
        existsSync(dest) && Bun.file(dest).size === undefined ? join(dest, src.split(/[/\\]/).pop()!) : dest;
      cpSync(srcPath, destPath, { recursive: true });
    }
    break;
  }

  case "rmrf":
    for (const p of args) {
      try {
        rmSync(resolve(p), { recursive: true, force: true });
      } catch {}
    }
    break;

  case "copy-cli": {
    const src = resolve("node_modules/@anthropic-ai/claude-agent-sdk/cli.js");
    const dest = resolve("dist/server/cli.js");
    if (existsSync(src)) {
      cpSync(src, dest);
      console.log("[build-helper] Copied cli.js to dist/server/");
    } else {
      console.warn("[build-helper] cli.js not found — Claude Code SDK not installed?");
    }
    break;
  }

  default:
    console.error(`Unknown command: ${cmd}`);
    process.exit(1);
}
