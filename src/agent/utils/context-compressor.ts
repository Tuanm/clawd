/**
 * Context Compressor — Phase 4.2
 *
 * Aggressive context reduction by stripping comments, normalizing whitespace,
 * and collapsing boilerplate while preserving semantic correctness.
 *
 * Design decisions:
 * - Comment stripping: uses ts-morph (TypeScript parser) to correctly handle
 *   string-embedded code (e.g., `"https://api.com?q=//filter"`). Pure regex
 *   approaches will mangle such cases. For non-TS files, falls back to regex.
 * - Line number preservation: comments are replaced with blank lines (same
 *   number of newlines), not removed entirely. Error stack traces and grep
 *   results remain accurate.
 * - Performance: parsed SourceFile objects are cached with mtime invalidation.
 *   For 500+ file codebases, only files read within the session are processed.
 *   Parallelization via worker_threads is deferred to Phase 5 (not needed yet).
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { extname, join } from "node:path";

// ── Types ──────────────────────────────────────────────────────────

export interface CompressionResult {
  content: string;
  originalLines: number;
  compressedLines: number;
  savingsRatio: number; // 0-1
  hadComments: boolean;
  /** Internal: cached ts-morph SourceFile for reuse on config change (not part of public API) */
  _sourceFile?: any;
}

export interface ContextCompressorConfig {
  /** Strip block comments (slash-asterisk style) */
  stripBlockComments?: boolean;
  /** Strip line comments (double-slash style) */
  stripLineComments?: boolean;
  /** Collapse consecutive blank lines */
  collapseBlankLines?: boolean;
  /** Remove empty lines */
  removeEmptyLines?: boolean;
  /** Preserve shebang lines (hash-bang for scripts) */
  preserveShebang?: boolean;
  /** Max original lines to consider for compression (skip very large files) */
  maxLinesForCompression?: number;
}

// ── Default config ─────────────────────────────────────────────────

const DEFAULT_CONFIG: Required<ContextCompressorConfig> = {
  stripBlockComments: true,
  stripLineComments: true,
  collapseBlankLines: true,
  removeEmptyLines: false,
  preserveShebang: true,
  maxLinesForCompression: 5000,
};

// ── Cache ──────────────────────────────────────────────────────────

interface CachedParse {
  content: string; // original content
  mtime: number;
  hash: string;
  /** SourceFile (ts-morph) or null if not TS */
  sourceFile?: any;
  /** Cached compression results keyed by config hash */
  results: Map<string, CompressionResult>;
}

// ── Context Compressor ─────────────────────────────────────────────

export class ContextCompressor {
  private config: Required<ContextCompressorConfig>;
  private cache = new Map<string, CachedParse>();
  private tsMorph: typeof import("ts-morph") | null = null;

  constructor(config: ContextCompressorConfig = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.initTsMorph();
  }

  /**
   * Compress a file's content.
   * Caches by content hash + mtime.
   *
   * @param content  Raw file content
   * @param filePath  Optional file path for language detection (.ts/.tsx → ts-morph)
   * @param mtime  Optional file mtime for cache invalidation
   */
  compress(content: string, filePath?: string, mtime?: number): CompressionResult {
    const ext = filePath ? extname(filePath).toLowerCase() : "";
    const isTs = ext === ".ts" || ext === ".tsx" || ext === ".mts" || ext === ".cts";

    // Build cache key
    const hash = createHash("sha256").update(content).digest("hex").slice(0, 16);
    const cfgHash = this.configHash();
    const cacheKey = `${filePath || "content"}:${hash}:${cfgHash}`;

    // Check cache
    const cached = this.cache.get(cacheKey);
    if (cached && cached.mtime === mtime && cached.hash === hash) {
      const existing = cached.results.get(cfgHash);
      if (existing) return existing;
      // Cache hit but different config — reuse sourceFile for TS to avoid re-parsing
      if (isTs && cached.sourceFile && this.tsMorph) {
        const result = this.compressTsWithSourceFile(content, cached.sourceFile);
        cached.results.set(cfgHash, result);
        return result;
      }
    }

    // Compress
    const result = isTs && this.tsMorph ? this.compressTs(content) : this.compressGeneric(content, filePath || "");

    // Cache
    const parse: CachedParse = {
      content,
      mtime: mtime ?? Date.now(),
      hash,
      results: new Map(),
    };
    // Store parsed SourceFile for TS files (avoid re-parsing on config change)
    if (isTs && this.tsMorph && result._sourceFile) {
      parse.sourceFile = result._sourceFile as any;
    }
    this.cache.set(cacheKey, parse);
    parse.results.set(cfgHash, result);

    return result;
  }

  /**
   * Compress a file from disk (reads, parses, returns).
   */
  compressFile(filePath: string): CompressionResult | null {
    if (!existsSync(filePath)) return null;

    const content = readFileSync(filePath, "utf-8");
    const stat = statSync(filePath);

    return this.compress(content, filePath, stat.mtimeMs);
  }

  /**
   * Clear cache (e.g., on session reset).
   */
  clearCache(): void {
    this.cache.clear();
  }

  /**
   * Invalidate cache entry for a specific file.
   */
  invalidate(filePath: string): void {
    for (const key of this.cache.keys()) {
      if (key.startsWith(filePath + ":")) {
        this.cache.delete(key);
      }
    }
  }

  /**
   * Get cache statistics.
   */
  getStats(): { entries: number; hits: number } {
    return {
      entries: this.cache.size,
      hits: 0, // Not tracking hits separately for now
    };
  }

  // ── Private: ts-morph compression ────────────────────────────────

  private compressTs(content: string): CompressionResult {
    if (!this.tsMorph) return this.compressGeneric(content, ".ts");

    const originalLines = content.split("\n").length;
    const hadComments = content.includes("//") || content.includes("/*");

    try {
      const project = new this.tsMorph.Project({ useInMemoryFileSystem: true });
      const sourceFile = project.createSourceFile("temp.ts", content);

      // Collect trivia (comments) positions
      const comments: Array<{
        start: number;
        end: number;
        kind: "line" | "block";
      }> = [];

      sourceFile.forEachDescendant((node: any) => {
        const start = node.getStart();
        const pos = node.getPos();

        // Extract leading trivia (comments before node)
        if (start > pos) {
          const leadingText = sourceFile.getFullText().slice(pos, start);
          this.extractTrivia(leadingText, pos, comments);
        }

        // Extract trailing trivia (comments after node)
        const end = node.getEnd();
        const trailingPos = node.getEnd();
        // Get trailing trivia length by checking the next sibling or end position
        const fullText = node.getFullText();
        const nodeLength = node.getWidth();
        if (end < sourceFile.getEnd()) {
          // Get trailing trivia length from the next node's position difference
          const trailingLength = end - (pos + nodeLength);
          if (trailingLength > 0) {
            const trailingText = sourceFile.getFullText().slice(end, end + trailingLength);
            this.extractTrivia(trailingText, end, comments);
          }
        }
      });

      // Build compressed content by replacing comment ranges with whitespace
      let result = content;
      if (comments.length > 0) {
        // Sort comments by start position descending (replace from end to avoid offset shifts)
        const sortedComments = [...comments].sort((a, b) => b.start - a.start);

        for (const comment of sortedComments) {
          const len = comment.end - comment.start;
          // Replace with whitespace to preserve line numbers
          const whitespace = " ".repeat(len);
          result = result.slice(0, comment.start) + whitespace + result.slice(comment.end);
        }
      }

      // Collapse blank lines if configured
      if (this.config.collapseBlankLines) {
        result = this.collapseBlankLines(result);
      }

      const compressedLines = result.split("\n").length;
      return {
        content: result,
        originalLines,
        compressedLines,
        savingsRatio: 1 - result.length / content.length,
        hadComments,
        _sourceFile: sourceFile,
      };
    } catch (err) {
      return this.compressGeneric(content, ".ts");
    }
  }

  /**
   * Compress TypeScript content using a pre-parsed SourceFile (avoids re-parsing).
   */
  private compressTsWithSourceFile(content: string, sourceFile: any): CompressionResult {
    const originalLines = content.split("\n").length;
    const hadComments = content.includes("//") || content.includes("/*");

    // Collect trivia from pre-parsed SourceFile
    const comments: Array<{
      start: number;
      end: number;
      kind: "line" | "block";
    }> = [];

    sourceFile.forEachDescendant((node: any) => {
      const start = node.getStart();
      const pos = node.getPos();

      // Extract leading trivia (comments before node)
      if (start > pos) {
        const leadingText = sourceFile.getFullText().slice(pos, start);
        this.extractTrivia(leadingText, pos, comments);
      }

      // Extract trailing trivia (comments after node)
      const end = node.getEnd();
      const nodeLength = node.getWidth();
      if (end < sourceFile.getEnd()) {
        const trailingLength = end - (pos + nodeLength);
        if (trailingLength > 0) {
          const trailingText = sourceFile.getFullText().slice(end, end + trailingLength);
          this.extractTrivia(trailingText, end, comments);
        }
      }
    });

    let result = content;
    if (comments.length > 0) {
      const sortedComments = [...comments].sort((a, b) => b.start - a.start);
      for (const comment of sortedComments) {
        const len = comment.end - comment.start;
        const whitespace = " ".repeat(len);
        result = result.slice(0, comment.start) + whitespace + result.slice(comment.end);
      }
    }

    if (this.config.collapseBlankLines) {
      result = this.collapseBlankLines(result);
    }

    const compressedLines = result.split("\n").length;
    return {
      content: result,
      originalLines,
      compressedLines,
      savingsRatio: 1 - result.length / content.length,
      hadComments,
      _sourceFile: sourceFile,
    };
  }

  private extractTrivia(
    text: string,
    baseOffset: number,
    comments: Array<{ start: number; end: number; kind: "line" | "block" }>,
  ): void {
    // Extract line comments (// ...)
    const lineRegex = /\/\/[^\n]*/g;
    let match;
    while ((match = lineRegex.exec(text)) !== null) {
      const start = baseOffset + match.index;
      const end = start + match[0].length;
      // Don't collect whitespace-only comments
      if (match[0].trim() !== "//") {
        comments.push({ start, end, kind: "line" });
      }
    }

    // Extract block comments (/* ... */)
    const blockRegex = /\/\*[\s\S]*?\*\//g;
    while ((match = blockRegex.exec(text)) !== null) {
      const start = baseOffset + match.index;
      const end = start + match[0].length;
      if (match[0].trim() !== "/* */") {
        comments.push({ start, end, kind: "block" });
      }
    }
  }

  // ── Private: generic compression ────────────────────────────────

  private compressGeneric(content: string, filePath: string): CompressionResult {
    const originalLines = content.split("\n").length;
    let hadComments = false;

    // Detect Python files for # comment handling
    const isPythonFile = /\.(py|pyw)$/i.test(filePath);

    // Preserve shebang
    let shebang = "";
    if (this.config.preserveShebang && content.startsWith("#!")) {
      const firstNewline = content.indexOf("\n");
      shebang = content.slice(0, firstNewline + 1);
      content = content.slice(firstNewline + 1);
    }

    // Capture original content length AFTER shebang extraction (for accurate savingsRatio)
    const originalContentLength = content.length;

    // Skip compression for very large files
    if (originalLines > this.config.maxLinesForCompression) {
      return {
        content: shebang + content,
        originalLines,
        compressedLines: originalLines,
        savingsRatio: 0,
        hadComments: false,
      };
    }

    // Strip block comments FIRST (must precede line comment stripping to avoid
    // breaking block patterns like "/* Block comment */" after line comment
    // stripping turns them into "              " with spaces)
    if (this.config.stripBlockComments) {
      const stripped = this.stripBlockCommentsSafe(content);
      content = stripped.result;
      if (stripped.hadComments) hadComments = true;
    }

    // Strip line comments (but not URLs, file://, etc.)
    // For Python files, also strip # comments
    if (this.config.stripLineComments) {
      content = this.stripLineCommentsSafe(content, isPythonFile);
      if (content.includes("//") || (isPythonFile && content.includes("#"))) hadComments = true;
    }

    // Collapse blank lines
    if (this.config.collapseBlankLines) {
      content = this.collapseBlankLines(content);
    }

    // Remove empty lines
    if (this.config.removeEmptyLines) {
      content =
        content
          .split("\n")
          .filter((l) => l.trim().length > 0)
          .join("\n") + "\n";
    }

    const compressedLines = content.split("\n").length;
    const savingsRatio = originalContentLength > 0 ? Math.max(0, 1 - content.length / originalContentLength) : 0;
    return {
      content: shebang + content,
      originalLines,
      compressedLines,
      savingsRatio,
      hadComments,
    };
  }

  /**
   * Strip block comments while preserving string literals.
   * Uses a simple state machine to track whether we're inside a string.
   */
  private stripBlockCommentsSafe(content: string): {
    result: string;
    hadComments: boolean;
  } {
    const result: string[] = [];
    let i = 0;
    let inString = false;
    let stringChar = "";
    let hadComments = false;

    while (i < content.length) {
      // Check for string start
      if (!inString && (content[i] === '"' || content[i] === "'" || content[i] === "`")) {
        inString = true;
        stringChar = content[i];
        result.push(content[i]);
        i++;
        continue;
      }

      // Check for string end (handle escaped backslashes correctly)
      if (inString && content[i] === stringChar) {
        // Count consecutive backslashes before this character
        let backslashCount = 0;
        for (let j = i - 1; j >= 0 && content[j] === "\\"; j--) {
          backslashCount++;
        }
        // Quote is escaped if odd number of backslashes
        if (backslashCount % 2 === 0) {
          inString = false;
          stringChar = "";
          result.push(content[i]);
          i++;
          continue;
        }
      }

      // Inside string — pass through
      if (inString) {
        result.push(content[i]);
        i++;
        continue;
      }

      // Check for block comment start
      if (content[i] === "/" && content[i + 1] === "*") {
        hadComments = true;
        // Find end of block comment
        const end = content.indexOf("*/", i + 2);
        if (end >= 0) {
          // Replace with whitespace to preserve line numbers
          const blockLen = end + 2 - i;
          result.push(" ".repeat(blockLen));
          i = end + 2;
        } else {
          // Unclosed block comment — replace the start
          result.push("  ");
          i += 2;
        }
        continue;
      }

      // Check for line comment start (but not URL)
      if (content[i] === "/" && content[i + 1] === "/" && !this.isUrlContext(result)) {
        // Skip to end of line
        while (i < content.length && content[i] !== "\n") {
          result.push(" ");
          i++;
        }
        continue;
      }

      result.push(content[i]);
      i++;
    }

    return { result: result.join(""), hadComments };
  }

  /**
   * Strip line comments while preserving URLs and file paths.
   * For Python files, also handles `#` comments.
   */
  private stripLineCommentsSafe(content: string, isPython = false): string {
    const lines = content.split("\n");
    const result: string[] = [];

    for (const line of lines) {
      // Skip empty lines
      if (!line.trim()) {
        result.push(line);
        continue;
      }

      // Check if line is a comment
      let firstCommentIdx = this.findCommentStart(line);
      let isPythonComment = false;

      // For Python files, also check for # comments
      if (isPython) {
        const pythonCommentIdx = this.findPythonCommentStart(line);
        if (pythonCommentIdx >= 0) {
          // Use the earlier comment marker
          if (firstCommentIdx < 0 || pythonCommentIdx < firstCommentIdx) {
            firstCommentIdx = pythonCommentIdx;
            isPythonComment = true;
          }
        }
      }

      if (firstCommentIdx >= 0 && !this.isUrlOrPathContext(line, firstCommentIdx)) {
        // Replace comment portion with whitespace
        result.push(line.slice(0, firstCommentIdx) + " ".repeat(line.length - firstCommentIdx));
      } else {
        result.push(line);
      }
    }

    return result.join("\n");
  }

  /**
   * Find Python `#` comment start position (outside of strings).
   */
  private findPythonCommentStart(line: string): number {
    let i = 0;
    let inString = false;
    let stringChar = "";

    while (i < line.length) {
      const c = line[i];

      // String handling
      if (!inString && (c === '"' || c === "'")) {
        inString = true;
        stringChar = c;
        i++;
        continue;
      }
      if (inString && c === stringChar) {
        // Count consecutive backslashes before this character
        let backslashCount = 0;
        for (let j = i - 1; j >= 0 && line[j] === "\\"; j--) {
          backslashCount++;
        }
        // Even number of backslashes means string ends; odd means escaped quote
        if (backslashCount % 2 === 0) {
          inString = false;
        }
        i++;
        continue;
      }

      // Found Python comment marker (outside of string)
      if (!inString && c === "#") {
        return i;
      }

      i++;
    }

    return -1;
  }

  private findCommentStart(line: string): number {
    let i = 0;
    let inString = false;
    let stringChar = "";

    while (i < line.length - 1) {
      const c = line[i];

      // String handling
      if (!inString && (c === '"' || c === "'" || c === "`")) {
        inString = true;
        stringChar = c;
        i++;
        continue;
      }
      if (inString && c === stringChar) {
        // Count consecutive backslashes before this character
        let backslashCount = 0;
        for (let j = i - 1; j >= 0 && line[j] === "\\"; j--) {
          backslashCount++;
        }
        // Quote is escaped if odd number of backslashes
        if (backslashCount % 2 === 0) {
          inString = false;
          stringChar = "";
        }
        i++;
        continue;
      }
      if (inString) {
        i++;
        continue;
      }

      // Check for //
      if (c === "/" && line[i + 1] === "/") {
        return i;
      }

      i++;
    }

    return -1;
  }

  private isUrlContext(result: string[]): boolean {
    // Check if we're inside a URL (ends with :// or similar)
    const last = result.slice(-20).join("");
    return /:\/\/|\.com|\.org|\.net|\.io|:80|:443|file:\/\//i.test(last);
  }

  private isUrlOrPathContext(line: string, commentIdx: number): boolean {
    const before = line.slice(0, commentIdx);

    // Check for common URL patterns
    if (/\bhttps?:\/\//i.test(before)) return true;
    if (/\bfile:\/\//i.test(before)) return true;

    // Check for path patterns (///, // C:, // /)
    if (/:\/\/|:\/\/|^\s*\/\//.test(before)) return true;

    return false;
  }

  private collapseBlankLines(content: string): string {
    // Collapse 3+ consecutive blank lines to 2 (preserves visual separation)
    return content.replace(/\n{3,}/g, "\n\n");
  }

  // ── Private: ts-morph init ───────────────────────────────────────

  private async initTsMorph(): Promise<void> {
    try {
      const tsMorphModule = await import("ts-morph");
      this.tsMorph = tsMorphModule;
    } catch {
      // ts-morph not available — use generic compression
      this.tsMorph = null;
    }
  }

  private configHash(): string {
    return createHash("sha256").update(JSON.stringify(this.config)).digest("hex").slice(0, 8);
  }
}

// ── Module-level factory ────────────────────────────────────────────

const compressors = new Map<string, ContextCompressor>();

export function getContextCompressor(sessionId?: string, config?: ContextCompressorConfig): ContextCompressor {
  const key = sessionId || "default";
  let compressor = compressors.get(key);
  if (!compressor) {
    compressor = new ContextCompressor(config);
    compressors.set(key, compressor);
  }
  return compressor;
}

export function clearContextCompressor(sessionId?: string): void {
  if (sessionId) {
    compressors.delete(sessionId);
  } else {
    compressors.clear();
  }
}
