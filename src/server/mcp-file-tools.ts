/**
 * MCP File Tools — Claw'd MCP server-side file operations
 *
 * Exposes 6 file tools via the Claw'd MCP server so CC agents can use
 * mcp__clawd__file_* tools even when CC's native file tools are disabled.
 *
 * Security model:
 * - All paths validated via validateMcpFilePath (symlink-safe, project-root boundary)
 * - ~/.clawd/config.json always blocked (all modes)
 * - Sandbox mode: enforces project-root boundary; tmpdir() allowed (cross-platform temp dir)
 * - YOLO mode: project-root boundary lifted, any path accessible (only ~/.clawd/config.json blocked)
 * - Atomic writes via same-directory temp file + rename
 * - Bug 6 fix: use split/join not String.prototype.replace ($ corruption)
 */

import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readdirSync, realpathSync, renameSync, statSync, unlinkSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, parse as parsePath, resolve, sep } from "node:path";
import { isSandboxEnabled } from "../agent/utils/sandbox";

// ============================================================================
// Path Security
// ============================================================================

interface ValidateMcpFilePathOk {
  resolved: string;
}
interface ValidateMcpFilePathErr {
  error: string;
}
type ValidateMcpFilePathResult = ValidateMcpFilePathOk | ValidateMcpFilePathErr;

/**
 * Validate and resolve a path for MCP file operations.
 *
 * - Resolves symlinks (blocks symlink escape — TOCTOU-safe)
 * - Always blocks ~/.clawd/config.json (protects Claw'd credentials in all modes)
 * - Sandbox mode: enforces project-root boundary; tmpdir() allowed (cross-platform temp dir)
 * - YOLO mode: project-root boundary lifted; any path is accessible
 * - Returns the symlink-resolved real path so callers use the same path as was validated
 */
function validateMcpFilePath(inputPath: string, projectRoot: string): ValidateMcpFilePathResult {
  const yolo = !isSandboxEnabled();

  // In YOLO mode, resolve the path and only block ~/.clawd/config.json
  if (yolo) {
    const abs = isAbsolute(inputPath) ? resolve(inputPath) : resolve(projectRoot || process.cwd(), inputPath);
    let real: string;
    try {
      real = realpathSync(abs);
    } catch {
      real = abs; // new file — no symlinks to resolve yet
    }
    const configPath = join(homedir(), ".clawd", "config.json");
    if (real === configPath || abs === configPath) {
      return { error: "Access to ~/.clawd/config.json is restricted." };
    }
    return { resolved: real };
  }

  // Guard: projectRoot must be a non-empty absolute path.
  // An empty or relative projectRoot collapses the boundary check (e.g. root="" makes
  // root+"/" = "/" and every absolute path passes startsWith). Reject early to prevent
  // a misconfigured or uninitialised caller from silently bypassing the sandbox.
  if (!projectRoot || !isAbsolute(projectRoot)) {
    return { error: "Invalid project root: must be a non-empty absolute path. This is a server configuration error." };
  }

  // Guard: filesystem root must be rejected — stripping trailing separators produces "",
  // which collapses the boundary check (root+sep === root → every path passes startsWith).
  // On Windows, path.parse("C:\\").root === "C:\\" catches drive roots.
  const { root: fsRoot } = parsePath(projectRoot);
  const stripped = projectRoot.replace(/[/\\]+$/, "");
  if (stripped === "" || stripped === fsRoot.replace(/[/\\]+$/, "")) {
    return { error: "Invalid project root: filesystem root is not allowed." };
  }

  // Normalize projectRoot to strip any trailing separator (prevents boundary check edge cases)
  const root = projectRoot.replace(/[/\\]+$/, "");

  // 1. Resolve absolute path (relative → under projectRoot)
  const abs = isAbsolute(inputPath) ? resolve(inputPath) : resolve(root, inputPath);

  // 2. Resolve symlinks (realpathSync — blocks symlink escape)
  let real: string;
  try {
    real = realpathSync(abs); // existing file: resolve all symlinks (full path)
  } catch {
    // File doesn't exist yet (create case). We cannot realpathSync the full path,
    // but intermediate directory symlinks can still escape project root.
    // Example attack: `ln -s /sensitive /project/src`, then file_create("/project/src/a/b/c")
    // — dirname is /project/src/a/b which also doesn't exist, so single-level dirname check
    // falls back to abs ("/project/src/a/b/c"), passing the boundary check but mkdirSync
    // follows the /project/src symlink to /sensitive.
    // Fix: walk up the path until we find the deepest existing ancestor, realpathSync it,
    // then re-append the non-existing tail segments.
    let checkPath = abs;
    const tail: string[] = [];
    let resolved = false;
    while (true) {
      const parent = dirname(checkPath);
      if (parent === checkPath) break; // reached filesystem root
      tail.unshift(basename(checkPath));
      checkPath = parent;
      try {
        real = join(realpathSync(checkPath), ...tail);
        resolved = true;
        break;
      } catch {
        // ancestor also doesn't exist, continue walking up
      }
    }
    if (!resolved) real = abs; // entire path is brand new — no symlinks possible yet
  }

  // 3. Block ~/.clawd/config.json explicitly
  const configPath = join(homedir(), ".clawd", "config.json");
  if (real === configPath || abs === configPath) {
    return { error: "Access to ~/.clawd/config.json is restricted." };
  }

  // 4. Enforce project root boundary (sandbox mode only — YOLO mode bypasses this entirely above).
  // tmpdir() is allowed: bwrap binds /tmp read-write (--bind /tmp /tmp); on Windows/macOS
  // tmpdir() returns the platform-native temp directory, so this is cross-platform.
  const tmp = tmpdir();
  const allowedPrefixes = [root, tmp];
  const allowed = allowedPrefixes.some((p) => real === p || real.startsWith(p + sep) || real.startsWith(p + "/"));
  if (!allowed) {
    return {
      error: `SANDBOX: Path "${inputPath}" is outside project root "${root}". Only files within the project root or the system temp directory are accessible via file tools.`,
    };
  }

  // TOCTOU: return `real` (symlink-resolved) so callers use the same path as was validated.
  // Returning `abs` would re-introduce a TOCTOU window where a symlink could be swapped
  // between validation and use.
  return { resolved: real };
}

// ============================================================================
// MCP Tool Definitions
// ============================================================================

export interface McpToolDef {
  name: string;
  description: string;
  inputSchema: {
    type: "object";
    properties: Record<string, unknown>;
    required: string[];
  };
}

export function getMcpFileToolDefs(): McpToolDef[] {
  return [
    {
      name: "file_view",
      description:
        "Read file content with line numbers, or list directory contents. " +
        "Supports start_line/end_line windowing. 1MB hard limit for file reads.",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string", description: "Absolute or project-relative path to file or directory" },
          start_line: { type: "number", description: "Start line (1-indexed, optional)" },
          end_line: { type: "number", description: "End line inclusive (optional)" },
        },
        required: ["path"],
      },
    },
    {
      name: "file_edit",
      description:
        "Replace exact string in a file. old_str must be unique unless replace_all=true. " +
        "Use file_multi_edit for multiple replacements in one file.",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string", description: "Absolute or project-relative path to file" },
          old_str: { type: "string", description: "Exact string to find (must be unique unless replace_all=true)" },
          new_str: { type: "string", description: "Replacement text" },
          replace_all: { type: "boolean", description: "Replace ALL occurrences (default: false)" },
        },
        required: ["path", "old_str", "new_str"],
      },
    },
    {
      name: "file_multi_edit",
      description:
        "Apply multiple replacements to one file atomically. " +
        "All old_str values are validated against the original content before any edits are applied. " +
        "If any old_str is not found, the entire operation is rejected (no partial changes).",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string", description: "Absolute or project-relative path to file" },
          edits: {
            type: "array",
            description: "Array of {old_str, new_str} replacements. Each old_str must be unique in the file.",
            items: {
              type: "object",
              properties: {
                old_str: { type: "string", description: "Text to find (must be unique in original file)" },
                new_str: { type: "string", description: "Replacement text" },
              },
              required: ["old_str", "new_str"],
            },
          },
        },
        required: ["path", "edits"],
      },
    },
    {
      name: "file_create",
      description:
        "Create a new file with the given content. Auto-creates parent directories. Fails if file exists unless overwrite=true.",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string", description: "Absolute or project-relative path for the new file" },
          content: { type: "string", description: "File content (default: empty string)" },
          overwrite: { type: "boolean", description: "Allow overwriting existing file (default: false)" },
        },
        required: ["path"],
      },
    },
    {
      name: "file_glob",
      description:
        'Find files matching a glob pattern using Bun.Glob. Supports full glob syntax: "**/*.ts", "src/**/*.tsx". ' +
        "Returns matching file paths, one per line.",
      inputSchema: {
        type: "object",
        properties: {
          pattern: { type: "string", description: 'Glob pattern e.g. "**/*.ts", "src/**/*.tsx"' },
          path: { type: "string", description: "Base directory (default: project root)" },
          head_limit: { type: "number", description: "Limit output to first N results" },
        },
        required: ["pattern"],
      },
    },
    {
      name: "file_grep",
      description:
        "Search file content with ripgrep. Output modes: 'content' shows matching lines, " +
        "'files_with_matches' shows only file paths (default), 'count' shows match counts.",
      inputSchema: {
        type: "object",
        properties: {
          pattern: { type: "string", description: "Regex pattern to search for" },
          path: { type: "string", description: "Directory or file to search (default: project root)" },
          glob: { type: "string", description: 'File filter e.g. "*.ts", "*.{js,tsx}"' },
          type: { type: "string", description: 'rg type filter e.g. "ts", "py"' },
          output_mode: {
            type: "string",
            enum: ["content", "files_with_matches", "count"],
            description: "Output mode (default: files_with_matches)",
          },
          context: { type: "number", description: "Lines of context around matches (content mode only)" },
          head_limit: { type: "number", description: "Limit output to first N results" },
          case_insensitive: { type: "boolean", description: "Case-insensitive search" },
        },
        required: ["pattern"],
      },
    },
  ];
}

// ============================================================================
// MCP Tool Response Type
// ============================================================================

interface McpToolResult {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}

function mcpOk(data: unknown): McpToolResult {
  return { content: [{ type: "text", text: typeof data === "string" ? data : JSON.stringify(data) }] };
}

function mcpError(msg: string): McpToolResult {
  return { content: [{ type: "text", text: `Error: ${msg}` }], isError: true };
}

// ============================================================================
// Atomic Write Helper
// ============================================================================

/**
 * Atomically write content to targetPath using a same-directory temp file + rename.
 * tmpPath MUST be in the same directory as targetPath for atomic rename(2) semantics.
 * Using /tmp would be cross-device and fall back to a non-atomic copy+delete.
 * Uses Bun.write() for efficient async I/O.
 */
async function atomicWrite(targetPath: string, content: string): Promise<void> {
  const tmpPath = `${targetPath}.clawd-tmp-${randomBytes(8).toString("hex")}`;
  try {
    await Bun.write(tmpPath, content);
    // Preserve permissions — rename(2) replaces the inode so temp file mode would overwrite original.
    // e.g. a chmod 600 .env would become 644 after any edit. Best-effort: ignore if stat fails.
    try {
      const origMode = statSync(targetPath).mode;
      chmodSync(tmpPath, origMode);
    } catch {
      // New file (create case) or target removed — use process umask defaults
    }
    renameSync(tmpPath, targetPath);
  } catch (err) {
    try {
      unlinkSync(tmpPath);
    } catch {}
    throw err;
  }
}

// ============================================================================
// Tool Implementations
// ============================================================================

async function toolFileView(args: Record<string, unknown>, projectRoot: string): Promise<McpToolResult> {
  const inputPath = args.path as string;
  if (!inputPath) return mcpError("path is required");

  const validated = validateMcpFilePath(inputPath, projectRoot);
  if ("error" in validated) return mcpError(validated.error);
  const { resolved } = validated;

  if (!existsSync(resolved)) return mcpError(`Path not found: ${inputPath}`);

  const stat = statSync(resolved);

  if (stat.isDirectory()) {
    const entries = readdirSync(resolved, { withFileTypes: true });
    const MAX_DIR_ENTRIES = 500;
    const truncated = entries.length > MAX_DIR_ENTRIES;
    const shown = truncated ? entries.slice(0, MAX_DIR_ENTRIES) : entries;
    const lines = shown.map((e) => `${e.isDirectory() ? "📁" : "📄"} ${e.name}`);
    if (truncated) lines.push(`... (${entries.length - MAX_DIR_ENTRIES} more entries — use file_glob to search)`);
    return mcpOk(lines.join("\n") || "(empty directory)");
  }

  // Binary file detection: check for null bytes in first 512 bytes
  // Edge case: UTF-16LE/BE files have null bytes every other byte but are valid text.
  // We check for BOM first to avoid false positives on UTF-16 encoded files.
  if (stat.size > 0) {
    try {
      const sample = new Uint8Array(await Bun.file(resolved).slice(0, 512).arrayBuffer());
      // UTF-16 BOM check: FF FE (LE) or FE FF (BE) — not binary, just a different text encoding
      const isUtf16 =
        sample.length >= 2 &&
        ((sample[0] === 0xff && sample[1] === 0xfe) || (sample[0] === 0xfe && sample[1] === 0xff));
      if (!isUtf16) {
        for (let i = 0; i < sample.length; i++) {
          if (sample[i] === 0) {
            return mcpError(
              `Binary file detected: ${inputPath}. Use file_glob to list or bash to process binary files.`,
            );
          }
        }
      }
    } catch {}
  }

  if (stat.size > 1024 * 1024) {
    return mcpError(
      `File too large (${(stat.size / 1024 / 1024).toFixed(1)}MB). Use start_line/end_line to read sections, or file_grep to find relevant parts first.`,
    );
  }

  const content = await Bun.file(resolved).text();
  const allLines = content.split("\n");

  const startLine = args.start_line as number | undefined;
  const endLine = args.end_line as number | undefined;

  let selectedLines: string[];
  let startIdx: number;
  if (startLine !== undefined || endLine !== undefined) {
    if (startLine !== undefined && startLine < 1) {
      return mcpError(`start_line must be ≥ 1 (got ${startLine})`);
    }
    if (endLine !== undefined && endLine < 1) {
      return mcpError(`end_line must be ≥ 1 (got ${endLine})`);
    }
    if (startLine !== undefined && startLine > allLines.length) {
      return mcpError(`start_line (${startLine}) exceeds file length (${allLines.length} lines)`);
    }
    if (startLine !== undefined && endLine !== undefined && startLine > endLine) {
      return mcpError(`start_line (${startLine}) must be ≤ end_line (${endLine})`);
    }
    const start = Math.max(1, startLine || 1);
    const end = Math.min(allLines.length, endLine || allLines.length);
    startIdx = start - 1;
    selectedLines = allLines.slice(startIdx, end);
  } else {
    startIdx = 0;
    selectedLines = allLines;
  }

  let output = selectedLines.map((line, i) => `${startIdx + i + 1}: ${line}`).join("\n");

  if (output.length > 50000) {
    output = `${output.slice(0, 50000)}\n\n[Content truncated. Use start_line/end_line to read specific sections.]`;
  }

  return mcpOk(output);
}

async function toolFileEdit(args: Record<string, unknown>, projectRoot: string): Promise<McpToolResult> {
  const inputPath = args.path as string;
  const oldStr = args.old_str as string;
  const newStr = args.new_str as string;
  const replaceAll = (args.replace_all as boolean) ?? false;

  if (!inputPath) return mcpError("path is required");
  if (oldStr === undefined || oldStr === null || oldStr === "") return mcpError("old_str cannot be empty");
  if (newStr === undefined || newStr === null) return mcpError("new_str is required");

  const validated = validateMcpFilePath(inputPath, projectRoot);
  if ("error" in validated) return mcpError(validated.error);
  const { resolved } = validated;

  if (!existsSync(resolved)) return mcpError(`File not found: ${inputPath}`);

  const content = await Bun.file(resolved).text();
  const count = content.split(oldStr).length - 1;

  if (count === 0) return mcpError("old_str not found in file");
  if (count > 1 && !replaceAll) {
    return mcpError(`old_str found ${count} times, must be unique. Use replace_all=true to replace all occurrences.`);
  }

  // Use split/join (NOT String.prototype.replace) to avoid $ special character corruption (Bug 6)
  const newContent = content.split(oldStr).join(newStr);

  await atomicWrite(resolved, newContent);

  return mcpOk(
    replaceAll
      ? `File updated: ${inputPath} (${count} replacement${count !== 1 ? "s" : ""})`
      : `File updated: ${inputPath}`,
  );
}

async function toolFileMultiEdit(args: Record<string, unknown>, projectRoot: string): Promise<McpToolResult> {
  const inputPath = args.path as string;
  const edits = args.edits as Array<{ old_str: string; new_str: string }>;

  if (!inputPath) return mcpError("path is required");
  if (!Array.isArray(edits) || edits.length === 0) return mcpError("edits must be a non-empty array");
  if (edits.length > 50) return mcpError("max 50 edits per call");

  const validated = validateMcpFilePath(inputPath, projectRoot);
  if ("error" in validated) return mcpError(validated.error);
  const { resolved } = validated;

  if (!existsSync(resolved)) return mcpError(`File not found: ${inputPath}`);

  const originalContent = await Bun.file(resolved).text();

  // Validate ALL edits against original content before applying any (all-or-nothing)
  const failures: string[] = [];
  const seenOldStrs = new Set<string>();
  for (let i = 0; i < edits.length; i++) {
    const { old_str, new_str } = edits[i];
    if (old_str === undefined || old_str === null || old_str === "") {
      failures.push(`Edit ${i + 1}: old_str is required`);
      continue;
    }
    // Check duplicate BEFORE new_str so that an old_str="foo"/new_str=null case still
    // registers "foo" in seenOldStrs and a later edit with old_str="foo" is flagged as duplicate.
    if (seenOldStrs.has(old_str)) {
      failures.push(`Edit ${i + 1}: duplicate old_str — same as a prior edit in this batch`);
      continue;
    }
    seenOldStrs.add(old_str);
    if (new_str === undefined || new_str === null) {
      failures.push(`Edit ${i + 1}: new_str is required`);
      continue;
    }
    const count = originalContent.split(old_str).length - 1;
    if (count === 0) failures.push(`Edit ${i + 1}: old_str not found in file`);
    else if (count > 1) failures.push(`Edit ${i + 1}: old_str found ${count} times, must be unique`);
  }
  if (failures.length > 0) {
    return mcpError(`Validation failed — no changes applied:\n${failures.join("\n")}`);
  }

  // Apply edits sequentially in memory (each applied to result of the previous)
  // Use split/join (NOT String.prototype.replace) to avoid $ special character corruption (Bug 6)
  // Also verify each old_str is still present before applying — a prior edit in the same batch
  // may have consumed it (e.g., edit 1 replaces "foo bar", then edit 2 looks for "bar" and silently
  // no-ops). Fail fast instead of silently writing partial results.
  let content = originalContent;
  for (let i = 0; i < edits.length; i++) {
    const { old_str, new_str } = edits[i];
    const occurrences = content.split(old_str).length - 1;
    if (occurrences === 0) {
      return mcpError(
        `Edit ${i + 1} failed: "${old_str.slice(0, 80)}" not found in intermediate content — ` +
          `it was likely consumed by a prior edit in the same batch. Reorder edits or split into separate calls. No changes were written.`,
      );
    }
    if (occurrences > 1) {
      return mcpError(
        `Edit ${i + 1} failed: "${old_str.slice(0, 80)}" appears ${occurrences} times in intermediate content — ` +
          `a prior edit synthesized duplicate occurrences. Reorder edits or split into separate calls. No changes were written.`,
      );
    }
    content = content.split(old_str).join(new_str);
  }

  await atomicWrite(resolved, content);

  return mcpOk(`Applied ${edits.length} edit${edits.length !== 1 ? "s" : ""} to ${inputPath}`);
}

async function toolFileCreate(args: Record<string, unknown>, projectRoot: string): Promise<McpToolResult> {
  const inputPath = args.path as string;
  const content = (args.content as string) ?? "";
  const overwrite = (args.overwrite as boolean) ?? false;

  if (!inputPath) return mcpError("path is required");
  if (typeof content !== "string") return mcpError("content must be a string");
  // 10MB limit — prevents OOM from accidental huge content strings
  if (content.length > 10 * 1024 * 1024) {
    return mcpError(
      `Content too large (${(content.length / 1024 / 1024).toFixed(1)}MB). Max 10MB per file_create call.`,
    );
  }

  const validated = validateMcpFilePath(inputPath, projectRoot);
  if ("error" in validated) return mcpError(validated.error);
  const { resolved } = validated;

  if (!overwrite && existsSync(resolved)) {
    return mcpError(`File already exists: ${inputPath}. Use overwrite=true to replace.`);
  }

  // Auto-create parent directories
  mkdirSync(dirname(resolved), { recursive: true });
  // Use atomicWrite for data integrity (prevents truncated files on crash mid-write)
  await atomicWrite(resolved, content);

  return mcpOk(`Created: ${inputPath}`);
}

async function toolFileGlob(args: Record<string, unknown>, projectRoot: string): Promise<McpToolResult> {
  const pattern = args.pattern as string;
  const basePath = (args.path as string) || projectRoot;
  const headLimit = args.head_limit as number | undefined;

  if (!pattern) return mcpError("pattern is required");
  // Reject ".." as a path segment (e.g. "../../etc/passwd") — segment-level check to avoid
  // blocking legitimate names like "*..backup" or "files/..hidden" that don't traverse.
  if (pattern.split("/").some((seg) => seg === "..")) {
    return mcpError("glob pattern may not contain '..' segments (path traversal not allowed)");
  }
  // Reject absolute patterns — Bun.Glob ignores cwd for absolute paths, bypassing baseDir.
  // This covers "/etc/passwd" and brace expansions like "{/etc/shadow,*.ts}".
  // Reject absolute path components in patterns — covers "/etc/passwd", "{/etc/shadow,*.ts}",
  // "{a,/etc/shadow}" (post-{-comma form). Regex matches: start-of-string `/`, `{/`, or `,/`.
  if (/(^|[{,])\//.test(pattern)) {
    return mcpError("glob pattern may not contain absolute paths (path traversal not allowed)");
  }

  // Validate base directory
  const validated = validateMcpFilePath(basePath, projectRoot);
  if ("error" in validated) return mcpError(validated.error);
  const { resolved: baseDir } = validated;

  if (!existsSync(baseDir)) return mcpError(`Directory not found: ${basePath}`);

  const stat = statSync(baseDir);
  if (!stat.isDirectory()) return mcpError(`Path is not a directory: ${basePath}`);

  // Use Bun.Glob (built-in, no external dependency)
  const glob = new Bun.Glob(pattern);
  const results: string[] = [];

  const baseDirWithSlash = baseDir.endsWith("/") ? baseDir : baseDir + "/";
  for await (const file of glob.scan({ cwd: baseDir, absolute: true, onlyFiles: true })) {
    // Post-filter step 1: logical path must be within baseDir (catches absolute brace expansions).
    if (!file.startsWith(baseDirWithSlash) && file !== baseDir) continue;
    // Post-filter step 2: realpathSync to resolve any directory symlinks (e.g. projectRoot/link→/etc).
    // Bun.Glob returns logical paths and traverses into symlinked directories, so without this
    // a symlink inside the project pointing outside it would leak filenames from outside the root.
    let realFile: string;
    try {
      realFile = realpathSync(file);
    } catch {
      continue; // file disappeared between glob and realpathSync — skip
    }
    if (!realFile.startsWith(baseDirWithSlash) && realFile !== baseDir) continue;
    results.push(realFile);
    if (headLimit && headLimit > 0 && results.length >= headLimit) break;
  }

  if (results.length === 0) return mcpOk("(no files found)");

  let output = results.join("\n");
  if (headLimit && headLimit > 0 && results.length >= headLimit) {
    output += `\n... (limited to ${headLimit} results)`;
  }

  return mcpOk(output);
}

/** Maps rg-compatible type names to Bun.Glob patterns for pure-TS file search */
const TYPE_GLOB_MAP: Record<string, string> = {
  ts: "**/*.{ts,tsx}",
  js: "**/*.{js,jsx,mjs,cjs}",
  py: "**/*.py",
  python: "**/*.py",
  rust: "**/*.rs",
  go: "**/*.go",
  java: "**/*.java",
  c: "**/*.{c,h}",
  cpp: "**/*.{cpp,cc,cxx,hxx,hpp}",
  cs: "**/*.cs",
  sh: "**/*.{sh,bash,zsh,fish}",
  json: "**/*.json",
  yaml: "**/*.{yaml,yml}",
  toml: "**/*.toml",
  md: "**/*.{md,markdown}",
  html: "**/*.{html,htm}",
  css: "**/*.{css,scss,sass,less}",
  sql: "**/*.sql",
  rb: "**/*.rb",
  php: "**/*.php",
  swift: "**/*.swift",
  kt: "**/*.{kt,kts}",
  xml: "**/*.xml",
  txt: "**/*.txt",
};

/** Known binary extensions — skipped without reading content */
const BINARY_EXTENSIONS = new Set([
  "png",
  "jpg",
  "jpeg",
  "gif",
  "bmp",
  "ico",
  "webp",
  "tiff",
  "avif",
  "pdf",
  "zip",
  "tar",
  "gz",
  "bz2",
  "xz",
  "7z",
  "rar",
  "br",
  "zst",
  "bin",
  "exe",
  "dll",
  "so",
  "dylib",
  "a",
  "o",
  "lib",
  "wasm",
  "woff",
  "woff2",
  "ttf",
  "otf",
  "eot",
  "mp3",
  "mp4",
  "webm",
  "avi",
  "mov",
  "mkv",
  "wav",
  "ogg",
  "flac",
  "opus",
  "class",
  "jar",
  "pyc",
  "pyo",
  "pyd",
  "db",
  "sqlite",
  "sqlite3",
  "psd",
  "ai",
  "sketch",
  "fig",
]);

/**
 * Pure TypeScript/Bun grep — no external binaries required.
 * Uses Bun.Glob for file discovery and JS RegExp for pattern matching.
 */
async function toolFileGrep(args: Record<string, unknown>, projectRoot: string): Promise<McpToolResult> {
  const pattern = args.pattern as string;
  const searchPath = (args.path as string) || projectRoot;
  const globFilter = args.glob as string | undefined;
  const type = args.type as string | undefined;
  const outputMode = (args.output_mode as string) || "files_with_matches";
  const contextLines = Math.min(Math.max(0, (args.context as number) ?? 0), 20);
  const headLimit = args.head_limit as number | undefined;
  const caseInsensitive = (args.case_insensitive as boolean) ?? false;

  if (!pattern) return mcpError("pattern is required");
  const validModes = ["content", "files_with_matches", "count"];
  if (!validModes.includes(outputMode)) {
    return mcpError(`Invalid output_mode "${outputMode}". Must be one of: ${validModes.join(", ")}`);
  }

  const validated = validateMcpFilePath(searchPath, projectRoot);
  if ("error" in validated) return mcpError(validated.error);
  const { resolved } = validated;

  let regex: RegExp;
  try {
    regex = new RegExp(pattern, caseInsensitive ? "im" : "m");
  } catch (e: unknown) {
    return mcpError(`Invalid regex pattern: ${e instanceof Error ? e.message : String(e)}`);
  }

  // Collect files to search
  const filesToSearch: string[] = [];
  const pathStat = statSync(resolved);

  if (pathStat.isFile()) {
    filesToSearch.push(resolved);
  } else if (pathStat.isDirectory()) {
    let scanPattern = "**/*";
    if (globFilter) {
      // Make simple globs like "*.ts" recursive; path-containing globs used as-is
      scanPattern = globFilter.includes("/") ? globFilter : `**/${globFilter}`;
    } else if (type) {
      scanPattern = TYPE_GLOB_MAP[type] ?? `**/*.${type}`;
    }
    const bunGlob = new Bun.Glob(scanPattern);
    for await (const file of bunGlob.scan({ cwd: resolved, absolute: true, onlyFiles: true })) {
      filesToSearch.push(file);
      if (filesToSearch.length >= 100_000) break; // safety cap
    }
  } else {
    return mcpError(`Path is not a file or directory: ${searchPath}`);
  }

  const output: string[] = [];
  let totalHits = 0;
  let limitReached = false;

  outer: for (const filePath of filesToSearch) {
    if (limitReached) break;

    // Skip known binary extensions
    const dotIdx = filePath.lastIndexOf(".");
    const ext = dotIdx >= 0 ? filePath.slice(dotIdx + 1).toLowerCase() : "";
    if (BINARY_EXTENSIONS.has(ext)) continue;

    let text: string;
    try {
      text = await Bun.file(filePath).text();
    } catch {
      continue; // skip unreadable / non-UTF8 files
    }

    // Quick binary check: null bytes in first 512 chars
    const sampleLen = Math.min(text.length, 512);
    for (let i = 0; i < sampleLen; i++) {
      if (text.charCodeAt(i) === 0) continue outer;
    }

    const lines = text.split("\n");
    const matchIndices: number[] = [];
    for (let i = 0; i < lines.length; i++) {
      regex.lastIndex = 0;
      if (regex.test(lines[i])) matchIndices.push(i);
    }
    if (matchIndices.length === 0) continue;

    if (outputMode === "files_with_matches") {
      output.push(filePath);
      totalHits++;
      if (headLimit && totalHits >= headLimit) limitReached = true;
    } else if (outputMode === "count") {
      output.push(`${filePath}:${matchIndices.length}`);
      totalHits++;
      if (headLimit && totalHits >= headLimit) limitReached = true;
    } else {
      // content mode: emit matching lines with optional surrounding context
      const shown = new Set<number>();
      for (const idx of matchIndices) {
        for (let j = Math.max(0, idx - contextLines); j <= Math.min(lines.length - 1, idx + contextLines); j++) {
          shown.add(j);
        }
      }
      const sorted = [...shown].sort((a, b) => a - b);
      let prev = -2;
      for (const i of sorted) {
        if (i > prev + 1 && prev >= 0) output.push("--");
        const isMatch = matchIndices.includes(i);
        const sep = isMatch ? ":" : "-";
        output.push(`${filePath}${sep}${i + 1}${sep}${lines[i]}`);
        prev = i;
        totalHits++;
        if (headLimit && totalHits >= headLimit) {
          limitReached = true;
          break;
        }
      }
    }
  }

  if (output.length === 0) return mcpOk("(no matches)");
  let result = output.join("\n");
  if (limitReached) result += `\n... (limited to ${headLimit} results)`;
  return mcpOk(result);
}

// ============================================================================
// Dispatcher
// ============================================================================

export async function executeMcpFileTool(
  name: string,
  args: Record<string, unknown>,
  projectRoot: string,
): Promise<McpToolResult> {
  // Top-level catch: convert unexpected I/O errors (EACCES, ENOENT race, disk full, etc.)
  // into proper MCP error responses instead of unhandled rejections that could crash the server.
  try {
    switch (name) {
      case "file_view":
        return await toolFileView(args, projectRoot);
      case "file_edit":
        return await toolFileEdit(args, projectRoot);
      case "file_multi_edit":
        return await toolFileMultiEdit(args, projectRoot);
      case "file_create":
        return await toolFileCreate(args, projectRoot);
      case "file_glob":
        return await toolFileGlob(args, projectRoot);
      case "file_grep":
        return await toolFileGrep(args, projectRoot);
      default:
        return mcpError(`Unknown file tool: ${name}`);
    }
  } catch (err: unknown) {
    return mcpError(`Unexpected error in ${name}: ${err instanceof Error ? err.message : String(err)}`);
  }
}
