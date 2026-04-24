/**
 * File Tools — view, edit, multi_edit, create, grep, glob, convert_to_markdown
 *
 * Registers file read/write/search tools into the shared tool registry.
 */

import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { getContextSessionId } from "../utils/agent-context";
import { ContextCompressor } from "../utils/context-compressor";
import { getReadOnceCache, ReadOnceCache } from "../utils/read-once";
import { isSandboxReady, registerTool, resolveSafePath, runInSandbox, validatePath } from "./registry";

// ============================================================================
// Tool: View
// ============================================================================
registerTool(
  "view",
  `View the contents of a file or list directory contents.

**Large File Warning:** Do NOT read entire large files (>1MB) - this wastes tokens and may exceed context limits.

**For Large Files:**
- Use start_line/end_line to read specific sections
- For images/videos: Use Gemini or describe tool instead of reading raw bytes
- For code: Read only the relevant functions/classes you need
- Use "grep" to find specific patterns first, then view just those lines

**Best Practices:**
- Always check file size first with "ls -lh" before reading
- Use grep to locate relevant sections, then view those specific lines
- For binaries/images: Skip entirely or use specialized vision tools`,
  {
    path: {
      type: "string",
      description: "Absolute path to file or directory",
    },
    start_line: {
      type: "number",
      description: "Start line number (1-indexed). Alias: offset",
    },
    end_line: {
      type: "number",
      description: "End line number. Alias: limit (as count from start_line)",
    },
    offset: {
      type: "number",
      description: "Alias for start_line (1-indexed line offset)",
    },
    limit: {
      type: "number",
      description: "Number of lines to read from start_line/offset",
    },
  },
  ["path"],
  async ({ path, start_line, end_line, offset, limit }) => {
    // Resolve aliases: offset → start_line, limit → end_line (as count)
    if (offset && !start_line) start_line = offset;
    if (limit && !end_line && start_line) end_line = start_line + limit - 1;
    try {
      const resolvedPath = resolveSafePath(path);

      // Always validate path first (checks both allowed paths AND sensitive files like .env)
      const pathError = validatePath(resolvedPath, "view");
      if (pathError) {
        return { success: false, output: "", error: pathError };
      }

      // Use sandbox for filesystem isolation
      if (isSandboxReady()) {
        // Check if file/dir exists and get type
        const testResult = await runInSandbox("test", ["-e", resolvedPath]);
        if (!testResult.success) {
          return {
            success: false,
            output: "",
            error: `Path not found: ${path}`,
          };
        }

        const isDirResult = await runInSandbox("test", ["-d", resolvedPath]);
        const isDir = isDirResult.success;

        if (isDir) {
          const result = await runInSandbox("ls", ["-1", resolvedPath]);
          if (!result.success) {
            return {
              success: false,
              output: "",
              error: result.stderr || "Failed to list directory",
            };
          }
          const entries = result.stdout.trim().split("\n").filter(Boolean);
          const output = entries.length > 0 ? entries.map((e) => `📄 ${e}`).join("\n") : "(empty directory)";
          return { success: true, output };
        }

        // Check file size before reading (using statSync - cross-platform, no shell dependency)
        try {
          const fileSize = statSync(resolvedPath).size;
          if (fileSize > 1024 * 1024) {
            return {
              success: false,
              output: "",
              error: `File too large (${(fileSize / 1024 / 1024).toFixed(1)}MB). Use start_line/end_line to read specific sections, or use grep to find relevant parts first.`,
            };
          }
        } catch {
          // stat failed - proceed and let cat report any error
        }

        // Read file
        const catArgs = [resolvedPath];
        const result = await runInSandbox("cat", catArgs);
        if (!result.success) {
          return {
            success: false,
            output: "",
            error: result.stderr || "Failed to read file",
          };
        }

        let content = result.stdout;
        const lines = content.split("\n");

        if (start_line || end_line) {
          const start = Math.max(1, start_line || 1) - 1;
          const end = Math.min(lines.length, end_line || lines.length);
          const selectedLines = lines.slice(start, end);
          content = selectedLines.map((line, i) => `${start + i + 1}. ${line}`).join("\n");
        } else {
          content = lines.map((line, i) => `${i + 1}. ${line}`).join("\n");
        }

        if (content.length > 50000) {
          content = `${content.slice(0, 50000)}\n\n[Content truncated - file too large. Use view() with start_line/end_line to read specific sections, or use grep to find relevant parts first.]`;
        }

        return { success: true, output: content };
      }

      // Fallback: direct fs access (path already validated above)
      if (!existsSync(resolvedPath)) {
        return { success: false, output: "", error: `Path not found: ${path}` };
      }

      const stat = statSync(resolvedPath);

      // Check file size before reading
      if (stat.size > 1024 * 1024) {
        return {
          success: false,
          output: "",
          error: `File too large (${(stat.size / 1024 / 1024).toFixed(1)}MB). Use start_line/end_line to read specific sections, or use grep to find relevant parts first.`,
        };
      }

      if (stat.isDirectory()) {
        const entries = readdirSync(resolvedPath, { withFileTypes: true });
        const output = entries.map((e) => `${e.isDirectory() ? "📁" : "📄"} ${e.name}`).join("\n");
        return { success: true, output: output || "(empty directory)" };
      }

      // ── Read-Once Cache + Context Compressor ─────────────────────────
      // Cache is session-scoped (one cache per sessionId). On cache miss,
      // reads the file and optionally strips comments via ContextCompressor.
      const sessionId = getContextSessionId();
      const cache = sessionId ? getReadOnceCache(sessionId) : null;
      let rawContent: string;

      if (cache) {
        // resolvedPath is always absolute (via resolveSafePath), so the
        // projectRoot arg to cache.read is unused — pass nothing rather
        // than process.cwd() to make that explicit.
        const cached = cache.read(resolvedPath);
        if (cached) {
          rawContent = cached.content;
        } else {
          rawContent = readFileSync(resolvedPath, "utf-8");
          // Compress: strip comments from code files (>5 lines, not binary)
          if (rawContent.split("\n").length > 5 && !isBinaryContent(rawContent)) {
            try {
              const comp = _fileCompressor.compress(rawContent, resolvedPath, stat.mtimeMs);
              if (comp.savingsRatio > 0.05) {
                rawContent = comp.content;
              }
            } catch {
              // Compression failed — use raw content
            }
          }
        }
      } else {
        rawContent = readFileSync(resolvedPath, "utf-8");
      }

      const lines = rawContent.split("\n");

      if (start_line || end_line) {
        const start = Math.max(1, start_line || 1) - 1;
        const end = Math.min(lines.length, end_line || lines.length);
        const selectedLines = lines.slice(start, end);
        rawContent = selectedLines.map((line, i) => `${start + i + 1}. ${line}`).join("\n");
      } else {
        rawContent = lines.map((line, i) => `${i + 1}. ${line}`).join("\n");
      }

      if (rawContent.length > 50000) {
        rawContent = `${rawContent.slice(0, 50000)}\n... (truncated)`;
      }

      return { success: true, output: rawContent };
    } catch (err: unknown) {
      return { success: false, output: "", error: err instanceof Error ? err.message : String(err) };
    }
  },
);

// ── Helpers ─────────────────────────────────────────────────────────

/** Quick binary check: null bytes in first 512 chars */
function isBinaryContent(content: string): boolean {
  const sample = content.slice(0, 512);
  for (let i = 0; i < sample.length; i++) {
    if (sample.charCodeAt(i) === 0) return true;
  }
  return false;
}

/** Module-level compressor — stateless, no session scoping needed */
const _fileCompressor = new ContextCompressor({
  stripBlockComments: true,
  stripLineComments: true,
  collapseBlankLines: true,
  preserveShebang: true,
  maxLinesForCompression: 5000,
});

/**
 * Bust the read-once cache for a file path.
 * Call this after any write operation to ensure the next view shows fresh content.
 */
function bustReadOnceCache(filePath: string): void {
  const sessionId = getContextSessionId();
  if (sessionId) {
    try {
      const cache = getReadOnceCache(sessionId);
      cache.invalidate(filePath);
    } catch {
      // Non-critical — cache may not exist yet
    }
  }
}

// ============================================================================
// Tool: Edit
// ============================================================================

registerTool(
  "edit",
  "Edit a file by replacing exact text. Use replace_all=true for renaming across the file. For multiple edits in one file, prefer multi_edit.",
  {
    path: { type: "string", description: "Absolute path to file" },
    old_str: { type: "string", description: "Text to find and replace (must be unique unless replace_all is true)" },
    new_str: { type: "string", description: "Replacement text" },
    replace_all: { type: "boolean", description: "Replace ALL occurrences (default: false, requires unique match)" },
  },
  ["path", "old_str", "new_str"],
  async ({ path, old_str, new_str, replace_all = false }) => {
    try {
      const resolvedPath = resolveSafePath(path);
      const pathError = validatePath(resolvedPath, "edit");
      if (pathError) return { success: false, output: "", error: pathError };

      // Read file content
      let content: string;
      if (isSandboxReady()) {
        const readResult = await runInSandbox("cat", [resolvedPath]);
        if (!readResult.success) {
          return {
            success: false,
            output: "",
            error: readResult.stderr.includes("No such file")
              ? `File not found: ${path}`
              : readResult.stderr || "Failed to read file",
          };
        }
        content = readResult.stdout;
      } else {
        if (!existsSync(resolvedPath)) return { success: false, output: "", error: `File not found: ${path}` };
        content = readFileSync(resolvedPath, "utf-8");
      }

      const count = content.split(old_str).length - 1;
      if (count === 0) return { success: false, output: "", error: "old_str not found in file" };
      if (count > 1 && !replace_all)
        return {
          success: false,
          output: "",
          error: `old_str found ${count} times, must be unique. Use replace_all=true to replace all occurrences.`,
        };

      // Apply replacement.
      // Use split/join for both paths to avoid String.prototype.replace $ special character corruption.
      // ($& = matched, $1 = group, etc. would silently corrupt new_str values containing $)
      content = content.split(old_str).join(new_str);

      // Write file
      if (isSandboxReady()) {
        const { randomUUID } = await import("node:crypto");
        const heredocDelim = `CLAWD_EOF_${randomUUID().replace(/-/g, "")}`;
        const writeResult = await runInSandbox("bash", [
          "-c",
          `cat > "${resolvedPath}" << '${heredocDelim}'\n${content}\n${heredocDelim}`,
        ]);
        if (!writeResult.success)
          return { success: false, output: "", error: writeResult.stderr || "Failed to write file" };
        // Bust cache for sandbox write
        bustReadOnceCache(resolvedPath);
      } else {
        writeFileSync(resolvedPath, content);
        // Bust read-once cache so next view shows the updated content
        bustReadOnceCache(resolvedPath);
      }

      return {
        success: true,
        output: replace_all ? `File updated: ${path} (${count} replacements)` : `File updated: ${path}`,
      };
    } catch (err: unknown) {
      return { success: false, output: "", error: err instanceof Error ? err.message : String(err) };
    }
  },
);

// ============================================================================
// Tool: Multi-Edit (batch string replacements in a single file)
// ============================================================================

registerTool(
  "multi_edit",
  "Apply multiple edits to a single file. Each edit replaces old_str with new_str. All edits are applied atomically — if any edit fails, no changes are made.",
  {
    path: { type: "string", description: "Absolute path to file" },
    edits: {
      type: "array",
      description: "Array of edits: [{old_str, new_str}]. Each old_str must be unique in the file.",
      items: {
        type: "object",
        properties: {
          old_str: { type: "string", description: "Text to find (must be unique)" },
          new_str: { type: "string", description: "Replacement text" },
        },
        required: ["old_str", "new_str"],
      },
    },
  },
  ["path", "edits"],
  async ({ path: inputPath, edits }) => {
    try {
      if (!Array.isArray(edits) || edits.length === 0) {
        return { success: false, output: "", error: "edits must be a non-empty array" };
      }
      if (edits.length > 50) {
        return { success: false, output: "", error: "max 50 edits per call" };
      }

      const resolvedPath = resolveSafePath(inputPath);
      const pathError = validatePath(resolvedPath, "edit");
      if (pathError) return { success: false, output: "", error: pathError };

      // Read file
      let content: string;
      if (isSandboxReady()) {
        const readResult = await runInSandbox("cat", [resolvedPath]);
        if (!readResult.success) {
          return {
            success: false,
            output: "",
            error: readResult.stderr.includes("No such file")
              ? `File not found: ${inputPath}`
              : readResult.stderr || "Failed to read file",
          };
        }
        content = readResult.stdout;
      } else {
        if (!existsSync(resolvedPath)) return { success: false, output: "", error: `File not found: ${inputPath}` };
        content = readFileSync(resolvedPath, "utf-8");
      }

      // Validate all edits first (atomic — fail before any changes)
      const seenOldStrs = new Set<string>();
      for (let i = 0; i < edits.length; i++) {
        const { old_str, new_str } = edits[i];
        if (!old_str) return { success: false, output: "", error: `Edit ${i + 1}: old_str is required` };
        if (new_str === undefined || new_str === null)
          return { success: false, output: "", error: `Edit ${i + 1}: new_str is required` };
        if (seenOldStrs.has(old_str))
          return {
            success: false,
            output: "",
            error: `Edit ${i + 1}: duplicate old_str — same as a prior edit in this batch`,
          };
        seenOldStrs.add(old_str);
        const count = content.split(old_str).length - 1;
        if (count === 0) return { success: false, output: "", error: `Edit ${i + 1}: old_str not found in file` };
        if (count > 1)
          return { success: false, output: "", error: `Edit ${i + 1}: old_str found ${count} times, must be unique` };
      }

      // Apply all edits sequentially.
      // Use split/join (NOT String.prototype.replace) to avoid $ special character corruption (Bug 6).
      // Verify each old_str is still present before applying — a prior edit may have consumed it.
      for (let i = 0; i < edits.length; i++) {
        const { old_str, new_str } = edits[i];
        const occurrences = content.split(old_str).length - 1;
        if (occurrences === 0) {
          return {
            success: false,
            output: "",
            error: `Edit ${i + 1}: old_str not found in intermediate content — likely consumed by a prior edit. Reorder edits or split into separate calls. No changes were written.`,
          };
        }
        if (occurrences > 1) {
          return {
            success: false,
            output: "",
            error: `Edit ${i + 1}: old_str appears ${occurrences} times in intermediate content — a prior edit synthesized duplicates. Reorder edits or split into separate calls. No changes were written.`,
          };
        }
        content = content.split(old_str).join(new_str);
      }

      // Write file
      if (isSandboxReady()) {
        const { randomUUID } = await import("node:crypto");
        const heredocDelim = `CLAWD_EOF_${randomUUID().replace(/-/g, "")}`;
        const writeResult = await runInSandbox("bash", [
          "-c",
          `cat > "${resolvedPath}" << '${heredocDelim}'\n${content}\n${heredocDelim}`,
        ]);
        if (!writeResult.success)
          return { success: false, output: "", error: writeResult.stderr || "Failed to write file" };
        // Bust cache for sandbox write
        bustReadOnceCache(resolvedPath);
      } else {
        writeFileSync(resolvedPath, content);
        bustReadOnceCache(resolvedPath);
      }

      return { success: true, output: `Applied ${edits.length} edit(s) to ${inputPath}` };
    } catch (err: unknown) {
      return { success: false, output: "", error: err instanceof Error ? err.message : String(err) };
    }
  },
);

// ============================================================================
// Tool: Create
// ============================================================================

registerTool(
  "create",
  "Create a new file. Fails if file exists unless overwrite=true. Prefer edit/multi_edit for modifying existing files.",
  {
    path: { type: "string", description: "Absolute path for the file" },
    content: { type: "string", description: "File content" },
    overwrite: { type: "boolean", description: "Allow overwriting existing files (default: false)" },
  },
  ["path", "content"],
  async ({ path, content, overwrite = false }) => {
    try {
      const resolvedPath = resolveSafePath(path);
      const pathError = validatePath(resolvedPath, "create");
      if (pathError) return { success: false, output: "", error: pathError };

      // Use sandbox for filesystem isolation
      if (isSandboxReady()) {
        // Check if file exists (block unless overwrite)
        if (!overwrite) {
          const existsResult = await runInSandbox("test", ["-e", resolvedPath]);
          if (existsResult.success) {
            return {
              success: false,
              output: "",
              error: `File already exists: ${path}. Use overwrite=true to replace.`,
            };
          }
        }

        // Create file using heredoc with random delimiter to prevent injection
        const { randomUUID: randomUUIDCreate } = await import("node:crypto");
        const heredocDelimCreate = `CLAWD_EOF_${randomUUIDCreate().replace(/-/g, "")}`;
        const writeResult = await runInSandbox("bash", [
          "-c",
          `cat > "${resolvedPath}" << '${heredocDelimCreate}'\n${content}\n${heredocDelimCreate}`,
        ]);
        if (!writeResult.success) {
          return {
            success: false,
            output: "",
            error: writeResult.stderr || "Failed to create file",
          };
        }
        // Bust cache for sandbox write
        bustReadOnceCache(resolvedPath);
        return { success: true, output: `Created: ${path}` };
      }

      // Fallback: direct fs access (path already validated above)
      if (!overwrite && existsSync(resolvedPath)) {
        return { success: false, output: "", error: `File already exists: ${path}. Use overwrite=true to replace.` };
      }

      writeFileSync(resolvedPath, content);
      // Bust read-once cache so next view shows the new file
      bustReadOnceCache(resolvedPath);
      return { success: true, output: `Created: ${path}` };
    } catch (err: unknown) {
      return { success: false, output: "", error: err instanceof Error ? err.message : String(err) };
    }
  },
);

// ============================================================================
// Tool: Grep
// ============================================================================

/** Maps rg-compatible type names to Bun.Glob patterns */
const GREP_TYPE_GLOB: Record<string, string> = {
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

/** Known binary extensions — skipped without reading */
const GREP_BINARY_EXTS = new Set([
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
]);

registerTool(
  "grep",
  "Search for patterns in files. Pure TypeScript/Bun — no external binaries required. Output modes: 'content' shows matching lines, 'files_with_matches' shows file paths only (default), 'count' shows match counts.",
  {
    pattern: { type: "string", description: "Regex pattern to search for" },
    path: { type: "string", description: "Directory or file to search (default: project root)" },
    glob: { type: "string", description: 'File glob filter (e.g., "*.ts", "*.{js,tsx}")' },
    type: { type: "string", description: 'File type filter (e.g., "ts", "py", "rust")' },
    output_mode: {
      type: "string",
      description: '"content" (matching lines), "files_with_matches" (paths only, default), "count" (match counts)',
    },
    context: { type: "number", description: "Lines of context around matches (for content mode)" },
    head_limit: { type: "number", description: "Limit output to first N results (default: unlimited)" },
    case_insensitive: { type: "boolean", description: "Case-insensitive search" },
    multiline: { type: "boolean", description: "Enable dotAll mode — '.' matches newlines (for multiline patterns)" },
  },
  ["pattern"],
  async ({ pattern, path = ".", glob, type, output_mode, context, head_limit, case_insensitive, multiline }) => {
    const resolvedPath = resolveSafePath(path);
    const mode = output_mode || "files_with_matches";
    const contextLines = Math.min(Math.max(0, context ?? 0), 20);

    const pathError = validatePath(resolvedPath, "grep");
    if (pathError) return { success: false, output: "", error: pathError };

    // Build regex flags: m=multiline anchors, i=case-insensitive, s=dotAll
    const flags = `m${case_insensitive ? "i" : ""}${multiline ? "s" : ""}`;
    let regex: RegExp;
    try {
      regex = new RegExp(pattern, flags);
    } catch (e: unknown) {
      return { success: false, output: "", error: `Invalid regex: ${e instanceof Error ? e.message : String(e)}` };
    }

    // Collect files
    const filesToSearch: string[] = [];
    const pathStat = statSync(resolvedPath);

    if (pathStat.isFile()) {
      filesToSearch.push(resolvedPath);
    } else if (pathStat.isDirectory()) {
      let scanPattern = "**/*";
      if (glob) {
        scanPattern = glob.includes("/") ? glob : `**/${glob}`;
      } else if (type) {
        scanPattern = GREP_TYPE_GLOB[type] ?? `**/*.${type}`;
      }
      const bunGlob = new Bun.Glob(scanPattern);
      for await (const file of bunGlob.scan({ cwd: resolvedPath, absolute: true, onlyFiles: true })) {
        filesToSearch.push(file);
        if (filesToSearch.length >= 100_000) break;
      }
    }

    const output: string[] = [];
    let totalHits = 0;
    let limitReached = false;

    outer: for (const filePath of filesToSearch) {
      if (limitReached) break;

      const dotIdx = filePath.lastIndexOf(".");
      const ext = dotIdx >= 0 ? filePath.slice(dotIdx + 1).toLowerCase() : "";
      if (GREP_BINARY_EXTS.has(ext)) continue;

      let text: string;
      try {
        text = await Bun.file(filePath).text();
      } catch {
        continue;
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

      if (mode === "files_with_matches") {
        output.push(filePath);
        totalHits++;
        if (head_limit && totalHits >= head_limit) limitReached = true;
      } else if (mode === "count") {
        output.push(`${filePath}:${matchIndices.length}`);
        totalHits++;
        if (head_limit && totalHits >= head_limit) limitReached = true;
      } else {
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
          if (head_limit && totalHits >= head_limit) {
            limitReached = true;
            break;
          }
        }
      }
    }

    if (output.length === 0) return { success: true, output: "(no matches)" };
    let result = output.join("\n");
    if (limitReached) result += `\n... (limited to ${head_limit} results)`;
    return { success: true, output: result };
  },
);

// ============================================================================
// Tool: Glob
// ============================================================================

registerTool(
  "glob",
  "Find files matching a glob pattern. Returns matching file paths sorted by modification time.",
  {
    pattern: { type: "string", description: 'Glob pattern (e.g., "**/*.ts", "src/**/*.tsx")' },
    path: { type: "string", description: "Base directory (default: project root)" },
    head_limit: { type: "number", description: "Limit output to first N files (default: unlimited)" },
  },
  ["pattern"],
  async ({ pattern, path = ".", head_limit }) => {
    const resolvedPath = resolveSafePath(path);

    // Validate path first (Bug 5: glob was skipping validatePath in sandbox mode, same as Bug 4/grep)
    const pathError = validatePath(resolvedPath, "glob");
    if (pathError) {
      return { success: false, output: "", error: pathError };
    }

    // Use Bun.Glob for correct full-pattern glob support (Bug 1 fix).
    // The old "find -name pattern.replace(**/, '')" approach was broken:
    // "src/**/*.ts" → "find {root} -name *.ts" (dropped the src/ prefix constraint).
    // Bun.Glob handles the full pattern correctly with zero external dependencies.
    try {
      const glob = new Bun.Glob(pattern);
      const results: string[] = [];
      for await (const file of glob.scan({ cwd: resolvedPath, absolute: true, onlyFiles: true })) {
        results.push(file);
        if (head_limit && head_limit > 0 && results.length >= head_limit) break;
      }
      if (results.length === 0) return { success: true, output: "(no files found)" };
      let output = results.join("\n");
      if (head_limit && head_limit > 0 && results.length >= head_limit) {
        output += `\n... (limited to ${head_limit} results)`;
      }
      return { success: true, output };
    } catch (err: unknown) {
      return { success: false, output: "", error: err instanceof Error ? err.message : String(err) };
    }
  },
);

registerTool(
  "convert_to_markdown",
  "Convert a document file to markdown and save as .md file in {projectRoot}/.clawd/files/. Returns the saved path and content size. Use view() to read the converted content. Supports: PDF, DOCX, XLSX, PPTX, HTML, EPUB, CSV. For images use read_image. For JSON/XML/YAML/text use view.",
  {
    path: {
      type: "string",
      description: "Absolute path to the file to convert",
    },
  },
  ["path"],
  async ({ path: filePath }: Record<string, any>) => {
    if (!filePath) {
      return { success: false, output: "", error: "path is required" };
    }

    const resolvedPath = resolveSafePath(filePath);
    const pathError = validatePath(resolvedPath, "convert_to_markdown");
    if (pathError) return { success: false, output: "", error: pathError };

    const { convertToMarkdown } = await import("./document-converter");
    const result = await convertToMarkdown(resolvedPath);

    if (!result.success) {
      return { success: false, output: "", error: result.error };
    }

    // Save to {originalProjectRoot}/.clawd/files/ (not worktree)
    const { writeFile, mkdir } = await import("node:fs/promises");
    const { basename, extname, join } = await import("node:path");
    const { getContextConfigRoot } = await import("../utils/agent-context");

    const configRoot = getContextConfigRoot();
    const filesDir = join(configRoot, ".clawd", "files");
    await mkdir(filesDir, { recursive: true });

    const base = basename(resolvedPath, extname(resolvedPath)).replace(/[^a-zA-Z0-9._-]/g, "_") || "converted";
    const mdPath = join(filesDir, `${base}.md`);
    await writeFile(mdPath, result.markdown, "utf-8");
    // Bust cache for this newly created file (if it somehow already existed in cache)
    bustReadOnceCache(mdPath);

    return {
      success: true,
      output: `Converted ${result.format.toUpperCase()} to Markdown (${result.markdown.length} chars). Saved to: ${mdPath}\nUse view("${mdPath}") to read the full content.`,
    };
  },
);

// ============================================================================
// Sub-Agent Cleanup
// ============================================================================

// ============================================================================
