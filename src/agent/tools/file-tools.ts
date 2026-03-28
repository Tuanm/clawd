/**
 * File Tools — view, edit, multi_edit, create, grep, glob, convert_to_markdown
 *
 * Registers file read/write/search tools into the shared tool registry.
 */

import { spawn } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
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

      let content = readFileSync(resolvedPath, "utf-8");
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
        content = `${content.slice(0, 50000)}\n... (truncated)`;
      }

      return { success: true, output: content };
    } catch (err: any) {
      return { success: false, output: "", error: err.message };
    }
  },
);

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

      // Apply replacement
      if (replace_all) {
        content = content.split(old_str).join(new_str);
      } else {
        content = content.replace(old_str, new_str);
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
      } else {
        writeFileSync(resolvedPath, content);
      }

      return {
        success: true,
        output: replace_all ? `File updated: ${path} (${count} replacements)` : `File updated: ${path}`,
      };
    } catch (err: any) {
      return { success: false, output: "", error: err.message };
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
      for (let i = 0; i < edits.length; i++) {
        const { old_str } = edits[i];
        if (!old_str) return { success: false, output: "", error: `Edit ${i + 1}: old_str is required` };
        const count = content.split(old_str).length - 1;
        if (count === 0) return { success: false, output: "", error: `Edit ${i + 1}: old_str not found in file` };
        if (count > 1)
          return { success: false, output: "", error: `Edit ${i + 1}: old_str found ${count} times, must be unique` };
      }

      // Apply all edits sequentially
      for (const { old_str, new_str } of edits) {
        content = content.replace(old_str, new_str);
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
      } else {
        writeFileSync(resolvedPath, content);
      }

      return { success: true, output: `Applied ${edits.length} edit(s) to ${inputPath}` };
    } catch (err: any) {
      return { success: false, output: "", error: err.message };
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

        return { success: true, output: `Created: ${path}` };
      }

      // Fallback: direct fs access (path already validated above)
      if (!overwrite && existsSync(resolvedPath)) {
        return { success: false, output: "", error: `File already exists: ${path}. Use overwrite=true to replace.` };
      }

      writeFileSync(resolvedPath, content);
      return { success: true, output: `Created: ${path}` };
    } catch (err: any) {
      return { success: false, output: "", error: err.message };
    }
  },
);

// ============================================================================
// Tool: Grep
// ============================================================================

registerTool(
  "grep",
  "Search for patterns in files using ripgrep. Output modes: 'content' shows matching lines, 'files_with_matches' shows file paths only (default), 'count' shows match counts.",
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
    multiline: { type: "boolean", description: "Enable multiline matching (patterns can span lines)" },
  },
  ["pattern"],
  async ({ pattern, path = ".", glob, type, output_mode, context, head_limit, case_insensitive, multiline }) => {
    const resolvedPath = resolveSafePath(path);
    const mode = output_mode || "files_with_matches";

    const args = ["--color=never"];
    if (mode === "files_with_matches") args.push("-l");
    else if (mode === "count") args.push("-c");
    else args.push("--line-number");
    if (glob) args.push("-g", glob);
    if (type) args.push("-t", type);
    if (context && mode === "content") args.push("-C", String(context));
    if (case_insensitive) args.push("-i");
    if (multiline) args.push("-U", "--multiline-dotall");
    args.push(pattern, resolvedPath);

    // Use sandbox for filesystem isolation
    if (isSandboxReady()) {
      const result = await runInSandbox("rg", args, { timeout: 30000 });

      // Check if rg is not installed (sandbox returns code 1 + "execvp" in stderr)
      if (result.stderr.includes("execvp") || result.stderr.includes("No such file")) {
        // Fallback to grep inside sandbox
        const grepArgs = ["-rn", "--color=never"];
        if (glob) {
          // Convert rg glob to grep --include (e.g., "*.ts" -> "--include=*.ts")
          grepArgs.push(`--include=${glob}`);
        }
        if (context) grepArgs.push("-C", String(context));
        grepArgs.push(pattern, resolvedPath);
        const grepResult = await runInSandbox("grep", grepArgs, { timeout: 30000 });
        return {
          success: grepResult.code === 0 || grepResult.code === 1,
          output: grepResult.stdout.trim() || "(no matches)",
        };
      }

      // rg returns 1 for no matches, which is not an error
      let output = result.stdout.trim() || "(no matches)";
      if (head_limit && head_limit > 0 && output !== "(no matches)") {
        const lines = output.split("\n");
        if (lines.length > head_limit) {
          output = lines.slice(0, head_limit).join("\n") + `\n... (${lines.length - head_limit} more)`;
        }
      }
      return { success: result.code === 0 || result.code === 1, output };
    }

    // Fallback: path validation + direct execution
    const pathError = validatePath(resolvedPath, "grep");
    if (pathError) {
      return { success: false, output: "", error: pathError };
    }

    return new Promise((resolve) => {
      const proc = spawn("rg", args);
      let timedOut = false;

      const timeoutId = setTimeout(() => {
        timedOut = true;
        proc.kill("SIGKILL");
      }, 30000);

      let output = "";
      proc.stdout?.on("data", (data) => {
        output += data.toString();
      });
      proc.stderr?.on("data", (data) => {
        output += data.toString();
      });

      proc.on("close", (code) => {
        clearTimeout(timeoutId);
        if (timedOut) {
          resolve({
            success: false,
            output: output.trim(),
            error: "TIMEOUT: Search exceeded 30s. Try a more specific pattern or smaller directory.",
          });
          return;
        }
        resolve({
          success: code === 0 || code === 1, // 1 = no matches
          output: output.trim() || "(no matches)",
        });
      });

      proc.on("error", () => {
        clearTimeout(timeoutId);
        // Fallback to grep if rg not available
        const grepFallbackArgs = ["-rn", pattern, resolvedPath];
        if (glob) grepFallbackArgs.splice(1, 0, `--include=${glob}`);
        const grepProc = spawn("grep", grepFallbackArgs);
        let grepTimedOut = false;

        const grepTimeoutId = setTimeout(() => {
          grepTimedOut = true;
          grepProc.kill("SIGKILL");
        }, 30000);

        let grepOutput = "";
        grepProc.stdout?.on("data", (data) => {
          grepOutput += data.toString();
        });
        grepProc.on("close", (code) => {
          clearTimeout(grepTimeoutId);
          if (grepTimedOut) {
            resolve({
              success: false,
              output: grepOutput.trim(),
              error: "TIMEOUT: Search exceeded 30s.",
            });
            return;
          }
          resolve({
            success: code === 0 || code === 1,
            output: grepOutput.trim() || "(no matches)",
          });
        });
      });
    });
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

    // Use sandbox for filesystem isolation
    if (isSandboxReady()) {
      const result = await runInSandbox("find", [resolvedPath, "-name", pattern.replace("**/", "")], {
        timeout: 30000,
      });
      let output = result.stdout.trim() || "(no files found)";
      if (head_limit && head_limit > 0 && output !== "(no files found)") {
        const lines = output.split("\n");
        if (lines.length > head_limit) {
          output = lines.slice(0, head_limit).join("\n") + `\n... (${lines.length - head_limit} more files)`;
        }
      }
      return { success: true, output };
    }

    // Fallback: path validation + direct execution
    const pathError = validatePath(resolvedPath, "glob");
    if (pathError) {
      return { success: false, output: "", error: pathError };
    }

    return new Promise((resolve) => {
      const proc = spawn("find", [resolvedPath, "-name", pattern.replace("**/", "")]);
      let timedOut = false;

      const timeoutId = setTimeout(() => {
        timedOut = true;
        proc.kill("SIGKILL");
      }, 30000);

      let output = "";
      proc.stdout?.on("data", (data) => {
        output += data.toString();
      });

      proc.on("close", () => {
        clearTimeout(timeoutId);
        if (timedOut) {
          resolve({
            success: false,
            output: output.trim(),
            error: "TIMEOUT: Search exceeded 30s. Try a smaller directory.",
          });
          return;
        }
        let result = output.trim() || "(no files found)";
        if (head_limit && head_limit > 0 && result !== "(no files found)") {
          const lines = result.split("\n");
          if (lines.length > head_limit) {
            result = lines.slice(0, head_limit).join("\n") + `\n... (${lines.length - head_limit} more files)`;
          }
        }
        resolve({ success: true, output: result });
      });

      proc.on("error", (err) => {
        clearTimeout(timeoutId);
        resolve({ success: false, output: "", error: err.message });
      });
    });
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
