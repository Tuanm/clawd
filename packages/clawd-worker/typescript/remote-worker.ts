#!/usr/bin/env -S npx tsx
/**
 * Claw'd Remote Worker — single-file TypeScript worker
 * Connects to a Claw'd server via WebSocket and executes file tools on the remote machine.
 * Runs with Bun or Node.js 22.4+. ZERO external dependencies.
 */

import { readFileSync, writeFileSync, existsSync, realpathSync, statSync, readdirSync, lstatSync } from "node:fs";
import { join, dirname, basename, resolve as pathResolve, delimiter, sep } from "node:path";
import { execSync, spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { randomUUID } from "node:crypto";
import { hostname } from "node:os";

// ---------------------------------------------------------------------------
// 1. Type definitions
// ---------------------------------------------------------------------------

interface ToolResult {
  success: boolean;
  output: string;
  error?: string;
}

interface ToolSchema {
  name: string;
  inputSchema: any;
  description: string;
}

// ---------------------------------------------------------------------------
// 2. Platform detection
// ---------------------------------------------------------------------------

const IS_WINDOWS = process.platform === "win32";
const IS_MACOS = process.platform === "darwin";

const IS_WSL2 =
  !IS_WINDOWS &&
  (() => {
    try {
      return readFileSync("/proc/version", "utf-8").toLowerCase().includes("microsoft");
    } catch {
      return false;
    }
  })();

function isDrvFs(p: string): boolean {
  return IS_WSL2 && /^\/mnt\/[a-z]\//i.test(p);
}

const REAL_TMP = (() => {
  try {
    return realpathSync("/tmp");
  } catch {
    return "/tmp";
  }
})();

const WIN_RESERVED = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(\..+)?$/i;

// ---------------------------------------------------------------------------
// 3. CLI argument parsing
// ---------------------------------------------------------------------------

interface WorkerConfig {
  server: string;
  token: string;
  projectRoot: string;
  name: string;
  readOnly: boolean;
  timeout: number;
  reconnectMax: number;
  insecure: boolean;
  caCert: string | null;
  maxConcurrent: number;
  cfClientId: string | null;
  cfClientSecret: string | null;
}

function printUsage(): never {
  console.error(`Usage: remote-worker --server <url> --token <token> [options]

Required:
  --server <url>         Claw'd server (e.g. clawd.example.com or localhost:3456)
  --token <token>        Auth token (or CLAWD_WORKER_TOKEN env var)

Options:
  --project-root <path>  Project root directory (default: cwd)
  --name <name>          Worker name (default: hostname)
  --read-only            Disable edit/create/bash tools
  --timeout <ms>         Default command timeout (default: 30000)
  --reconnect-max <s>    Max reconnect delay in seconds (default: 300)
  --insecure             Disable TLS certificate verification
  --ca-cert <path>       Custom CA certificate file path
  --max-concurrent <n>   Max concurrent tool calls (default: 4)
  --cf-client-id <id>    Cloudflare Access service token client ID (or CF_ACCESS_CLIENT_ID env)
  --cf-client-secret <s> Cloudflare Access service token secret (or CF_ACCESS_CLIENT_SECRET env)
`);
  process.exit(1);
}

/** Normalize server input: bare domain/host:port → full WebSocket URL */
function normalizeServerUrl(input: string): string {
  let url = input.trim().replace(/\/+$/, "");
  // Strip trailing path if user included it
  url = url.replace(/\/worker\/ws\/?$/, "");
  // Add scheme if missing
  if (!/^wss?:\/\//i.test(url)) {
    if (/^https?:\/\//i.test(url)) {
      url = url.replace(/^http:/i, "ws:").replace(/^https:/i, "wss:");
    } else {
      const isLocal = /^(localhost|127\.|0\.0\.0\.|::1|\[::1\])(:|$)/i.test(url);
      url = (isLocal ? "ws://" : "wss://") + url;
    }
  }
  return url;
}

function parseArgs(): WorkerConfig {
  const argv = process.argv.slice(2);
  let server = "";
  let token = process.env.CLAWD_WORKER_TOKEN || "";
  let projectRoot = process.cwd();
  let name = hostname();
  let readOnly = false;
  let timeout = 30000;
  let reconnectMax = 300;
  let insecure = false;
  let caCert: string | null = null;
  let maxConcurrent = 4;
  let cfClientId: string | null = process.env.CF_ACCESS_CLIENT_ID || null;
  let cfClientSecret: string | null = process.env.CF_ACCESS_CLIENT_SECRET || null;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case "--server":
        server = argv[++i] || "";
        break;
      case "--token":
        token = argv[++i] || "";
        break;
      case "--project-root":
        projectRoot = pathResolve(argv[++i] || ".");
        break;
      case "--name":
        name = argv[++i] || hostname();
        break;
      case "--read-only":
        readOnly = true;
        break;
      case "--timeout":
        timeout = parseInt(argv[++i], 10) || 30000;
        break;
      case "--reconnect-max":
        reconnectMax = parseInt(argv[++i], 10) || 300;
        break;
      case "--insecure":
        insecure = true;
        break;
      case "--ca-cert":
        caCert = argv[++i] || null;
        break;
      case "--max-concurrent":
        maxConcurrent = parseInt(argv[++i], 10) || 4;
        break;
      case "--cf-client-id":
        cfClientId = argv[++i] || null;
        break;
      case "--cf-client-secret":
        cfClientSecret = argv[++i] || null;
        break;
      default:
        console.error(`Unknown argument: ${arg}`);
        printUsage();
    }
  }

  if (!server) {
    console.error("Error: --server is required");
    printUsage();
  }
  // Normalize server URL: accept bare domain/host:port, auto-add scheme and path
  server = normalizeServerUrl(server);

  if (!token) {
    console.error("Error: --token or CLAWD_WORKER_TOKEN is required");
    printUsage();
  }

  // Resolve project root to absolute path
  projectRoot = pathResolve(projectRoot);
  if (!existsSync(projectRoot)) {
    console.error(`Error: project root does not exist: ${projectRoot}`);
    process.exit(1);
  }

  return {
    server,
    token,
    projectRoot,
    name,
    readOnly,
    timeout,
    reconnectMax,
    insecure,
    caCert,
    maxConcurrent,
    cfClientId,
    cfClientSecret,
  };
}

const config = parseArgs();

// ---------------------------------------------------------------------------
// 4. Security module
// ---------------------------------------------------------------------------

function normalizePath(p: string): string {
  let normalized = p.replace(/\\/g, "/");
  if (IS_WINDOWS || IS_MACOS || isDrvFs(p)) {
    normalized = normalized.toLowerCase();
  }
  // M1: Strip trailing slash (except root "/")
  if (normalized.length > 1 && normalized.endsWith("/")) {
    normalized = normalized.slice(0, -1);
  }
  return normalized;
}

function validatePath(
  targetPath: string,
  projectRoot: string,
): { ok: true; resolved: string } | { ok: false; error: string } {
  try {
    let resolved: string;
    if (existsSync(targetPath)) {
      resolved = realpathSync(targetPath);
    } else {
      const parentDir = dirname(targetPath);
      if (!existsSync(parentDir)) {
        return { ok: false, error: `Parent directory does not exist: ${parentDir}` };
      }
      resolved = join(realpathSync(parentDir), basename(targetPath));
    }

    // Windows reserved names
    if (IS_WINDOWS && WIN_RESERVED.test(basename(resolved))) {
      return { ok: false, error: `Reserved filename on Windows: ${basename(resolved)}` };
    }

    // Sensitive file check
    if (isSensitiveFile(resolved)) {
      return { ok: false, error: `Access denied: sensitive file ${basename(resolved)}` };
    }

    // Path containment check — M2: resolve projectRoot with realpathSync
    const normalizedResolved = normalizePath(resolved);
    let realRoot: string;
    try {
      realRoot = realpathSync(projectRoot);
    } catch {
      realRoot = projectRoot;
    }
    const normalizedRoot = normalizePath(realRoot);
    const normalizedTmp = normalizePath(REAL_TMP);

    const inRoot = normalizedResolved === normalizedRoot || normalizedResolved.startsWith(normalizedRoot + "/");
    const inTmp = normalizedResolved === normalizedTmp || normalizedResolved.startsWith(normalizedTmp + "/");

    if (!inRoot && !inTmp) {
      return { ok: false, error: `Path escapes project root: ${resolved}` };
    }

    return { ok: true, resolved };
  } catch (e: any) {
    return { ok: false, error: `Path validation failed: ${e.message}` };
  }
}

function isSensitiveFile(targetPath: string): boolean {
  const name = basename(targetPath);

  // .env or .env.* but NOT .env.example or *.example
  if (name === ".env" || (/^\.env\..+/.test(name) && !name.endsWith(".example"))) {
    return true;
  }

  if (/^\.secret/i.test(name)) return true;

  // H1: Suffix-match for key/cert extensions, exact-match for known filenames
  if (name.endsWith(".pem") || name.endsWith(".key")) return true;

  const sensitiveExact = ["id_rsa", "id_ed25519", ".npmrc", ".pypirc", ".netrc", "credentials"];
  if (sensitiveExact.includes(name)) return true;

  return false;
}

function truncateOutput(str: string, maxLen = 50000): string {
  if (str.length <= maxLen) return str;
  return str.slice(0, maxLen) + "\n[output truncated]";
}

function sanitizeSecrets(output: string): string {
  return output
    .replace(/(?:API_KEY|SECRET|PASSWORD|TOKEN)\s*[=:]\s*\S+/gi, "[REDACTED]")
    .replace(/ghp_[a-zA-Z0-9]{36}/g, "[REDACTED]")
    .replace(/sk-[a-zA-Z0-9]{32,}/g, "[REDACTED]")
    .replace(/AKIA[A-Z0-9]{16}/g, "[REDACTED]")
    .replace(/-----BEGIN\s+(RSA\s+)?PRIVATE\s+KEY-----[\s\S]*?-----END/g, "[REDACTED]")
    .replace(/eyJ[a-zA-Z0-9_-]{20,}\.[a-zA-Z0-9_-]{20,}/g, "[REDACTED]");
}

// ---------------------------------------------------------------------------
// 5. Shell resolution (cross-platform)
// ---------------------------------------------------------------------------

function findGitBash(): string | null {
  const candidates = [
    join(process.env.ProgramFiles || "C:\\Program Files", "Git", "bin", "bash.exe"),
    join(process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)", "Git", "bin", "bash.exe"),
    join(process.env.LOCALAPPDATA || "", "Programs", "Git", "bin", "bash.exe"),
  ];
  for (const c of candidates) {
    if (c && existsSync(c)) return c;
  }
  for (const dir of (process.env.PATH || "").split(delimiter)) {
    const bash = join(dir, "bash.exe");
    if (existsSync(bash)) return bash;
  }
  return null;
}

function resolveShell(command: string): { exe: string; args: string[] } {
  if (!IS_WINDOWS) return { exe: "bash", args: ["-c", command] };

  const gitBash = findGitBash();
  if (gitBash) return { exe: gitBash, args: ["-c", command] };

  for (const ps of ["pwsh.exe", "powershell.exe"]) {
    try {
      execSync(`where ${ps}`, { stdio: "ignore" });
      return { exe: ps, args: ["-NoProfile", "-NonInteractive", "-Command", command] };
    } catch {
      // try next
    }
  }
  return { exe: "cmd.exe", args: ["/c", command] };
}

// ---------------------------------------------------------------------------
// 6. Process management
// ---------------------------------------------------------------------------

function killProcessTree(pid: number): void {
  if (IS_WINDOWS) {
    try {
      execSync(`taskkill /PID ${pid} /T /F`, { stdio: "ignore" });
    } catch {
      // already dead
    }
  } else {
    try {
      process.kill(-pid, "SIGTERM");
    } catch {
      // already dead
    }
    setTimeout(() => {
      try {
        process.kill(-pid, "SIGKILL");
      } catch {
        // already dead
      }
    }, 3000);
  }
}

function getSpawnOptions(cwd: string): SpawnOptions {
  if (IS_WINDOWS) return { cwd, stdio: ["ignore", "pipe", "pipe"] };
  return { cwd, detached: true, stdio: ["ignore", "pipe", "pipe"] };
}

const activeProcesses = new Map<string, ChildProcess>();
// M4: Track cancelled calls to prevent double-send after cancel
const cancelledCalls = new Set<string>();

// ---------------------------------------------------------------------------
// 7. Tool implementations
// ---------------------------------------------------------------------------

function runCommand(cmd: string, args: string[]): Promise<ToolResult> {
  return new Promise((resolve) => {
    const proc = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    proc.stdout!.on("data", (d: Buffer) => {
      out += d.toString();
    });
    proc.stderr!.on("data", (d: Buffer) => {
      err += d.toString();
    });
    proc.on("close", (code) => {
      resolve({
        success: code === 0,
        output: sanitizeSecrets(truncateOutput(out)),
        error: code !== 0 ? err.slice(0, 500) : undefined,
      });
    });
    proc.on("error", (e) => {
      resolve({ success: false, output: "", error: e.message });
    });
  });
}

// -- view --

async function handleView(args: { path: string; start_line?: number; end_line?: number }): Promise<ToolResult> {
  const v = validatePath(args.path, config.projectRoot);
  if (!v.ok) return { success: false, output: "", error: v.error };

  const resolved = v.resolved;

  try {
    const stat = statSync(resolved);

    if (stat.isDirectory()) {
      // List directory contents up to 2 levels deep
      const entries: string[] = [];
      listDir(resolved, resolved, 0, 2, entries);
      return { success: true, output: entries.join("\n") };
    }

    const content = readFileSync(resolved, "utf-8");
    const lines = content.split(/\r?\n/);

    const start = args.start_line ? Math.max(1, args.start_line) : 1;
    const end = args.end_line ? Math.min(lines.length, args.end_line) : lines.length;

    const numbered = lines.slice(start - 1, end).map((line, i) => `${start + i}. ${line}`);

    return { success: true, output: sanitizeSecrets(truncateOutput(numbered.join("\n"))) };
  } catch (e: any) {
    return { success: false, output: "", error: e.message };
  }
}

function listDir(dir: string, root: string, depth: number, maxDepth: number, entries: string[]): void {
  if (depth >= maxDepth) return;
  try {
    const items = readdirSync(dir);
    for (const item of items) {
      if (item.startsWith(".")) continue; // skip hidden
      const full = join(dir, item);
      const rel = full.slice(root.length + 1);
      try {
        const stat = lstatSync(full);
        if (stat.isDirectory()) {
          entries.push(rel + "/");
          listDir(full, root, depth + 1, maxDepth, entries);
        } else {
          entries.push(rel);
        }
      } catch {
        // skip inaccessible
      }
    }
  } catch {
    // skip inaccessible
  }
}

// -- edit --

async function handleEdit(args: { path: string; old_str: string; new_str: string }): Promise<ToolResult> {
  if (config.readOnly) return { success: false, output: "", error: "Read-only mode: edit is disabled" };

  const v = validatePath(args.path, config.projectRoot);
  if (!v.ok) return { success: false, output: "", error: v.error };

  const resolved = v.resolved;

  try {
    if (!existsSync(resolved)) {
      return { success: false, output: "", error: `File does not exist: ${resolved}` };
    }

    const content = readFileSync(resolved, "utf-8");

    // H3: CRLF-aware matching
    // Step 1: Try exact match first
    let idx = content.indexOf(args.old_str);

    let effectiveOld = args.old_str;
    let effectiveNew = args.new_str;

    if (idx === -1) {
      // Step 2: Detect CRLF mismatch and retry with converted line endings
      const fileCRLF = content.includes("\r\n");
      const oldCRLF = args.old_str.includes("\r\n");

      if (fileCRLF !== oldCRLF) {
        if (fileCRLF) {
          // File uses CRLF, old_str uses LF → convert old_str to CRLF
          effectiveOld = args.old_str.replace(/\n/g, "\r\n");
          effectiveNew = args.new_str.replace(/\n/g, "\r\n");
        } else {
          // File uses LF, old_str uses CRLF → convert old_str to LF
          effectiveOld = args.old_str.replace(/\r\n/g, "\n");
          effectiveNew = args.new_str.replace(/\r\n/g, "\n");
        }
        idx = content.indexOf(effectiveOld);
      }

      if (idx === -1) {
        return { success: false, output: "", error: "old_str not found in file" };
      }
    }

    // Check uniqueness
    const secondIdx = content.indexOf(effectiveOld, idx + 1);
    if (secondIdx !== -1) {
      return {
        success: false,
        output: "",
        error: "old_str matches multiple locations — add more context to make it unique",
      };
    }

    // Step 4: Preserve matched region's line ending style in new_str
    const matchedRegion = content.slice(idx, idx + effectiveOld.length);
    const regionCRLF = matchedRegion.includes("\r\n");
    const newHasCRLF = effectiveNew.includes("\r\n");
    const newHasLF = effectiveNew.includes("\n");

    if (regionCRLF && !newHasCRLF && newHasLF) {
      effectiveNew = effectiveNew.replace(/\n/g, "\r\n");
    } else if (!regionCRLF && newHasCRLF) {
      effectiveNew = effectiveNew.replace(/\r\n/g, "\n");
    }

    const newContent = content.slice(0, idx) + effectiveNew + content.slice(idx + effectiveOld.length);
    writeFileSync(resolved, newContent, "utf-8");

    return { success: true, output: `Edited ${resolved}` };
  } catch (e: any) {
    return { success: false, output: "", error: e.message };
  }
}

// -- create --

async function handleCreate(args: { path: string; content: string }): Promise<ToolResult> {
  if (config.readOnly) return { success: false, output: "", error: "Read-only mode: create is disabled" };

  const v = validatePath(args.path, config.projectRoot);
  if (!v.ok) return { success: false, output: "", error: v.error };

  const resolved = v.resolved;

  try {
    if (existsSync(resolved)) {
      return { success: false, output: "", error: `File already exists: ${resolved}` };
    }

    const parentDir = dirname(resolved);
    if (!existsSync(parentDir)) {
      return { success: false, output: "", error: `Parent directory does not exist: ${parentDir}` };
    }

    writeFileSync(resolved, args.content, "utf-8");
    return { success: true, output: `Created ${resolved}` };
  } catch (e: any) {
    return { success: false, output: "", error: e.message };
  }
}

// -- grep --

async function handleGrep(args: {
  pattern: string;
  path?: string;
  glob?: string;
  context?: number;
}): Promise<ToolResult> {
  const searchPath = args.path || config.projectRoot;
  const v = validatePath(searchPath, config.projectRoot);
  if (!v.ok) return { success: false, output: "", error: v.error };

  const resolved = v.resolved;
  const ctx = args.context ?? 0;

  // Try ripgrep first
  const rgArgs = ["--no-follow", "-n", "--color", "never"];
  if (ctx > 0) rgArgs.push(`-C`, String(ctx));
  if (args.glob) rgArgs.push("--glob", args.glob);
  rgArgs.push(args.pattern, resolved);

  const rgResult = await runCommand("rg", rgArgs);

  // C2: runCommand resolves (never rejects) on spawn error — check error text
  const rgMissing = rgResult.error?.includes("ENOENT") || rgResult.error?.includes("not found");

  if (!rgMissing) {
    return rgResult;
  }

  // Fallback
  if (IS_WINDOWS) {
    const searchTarget = statSync(resolved).isDirectory() ? join(resolved, "*") : resolved;
    return runCommand("findstr", ["/s", "/n", "/r", args.pattern, searchTarget]);
  }

  const grepArgs = ["-rn"];
  if (ctx > 0) grepArgs.push(`-C${ctx}`);
  if (args.glob) grepArgs.push("--include", args.glob);
  grepArgs.push(args.pattern, resolved);

  return runCommand("grep", grepArgs);
}

// -- glob --

async function handleGlob(args: { pattern: string; path?: string }): Promise<ToolResult> {
  const searchPath = args.path || config.projectRoot;
  const v = validatePath(searchPath, config.projectRoot);
  if (!v.ok) return { success: false, output: "", error: v.error };

  const resolved = v.resolved;

  try {
    const results: string[] = [];
    globWalk(resolved, args.pattern, resolved, results, 1000);
    return { success: true, output: results.join("\n") };
  } catch (e: any) {
    return { success: false, output: "", error: e.message };
  }
}

function globWalk(dir: string, pattern: string, root: string, results: string[], limit: number): void {
  if (results.length >= limit) return;

  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }

  for (const entry of entries) {
    if (results.length >= limit) return;
    if (entry.startsWith(".")) continue;

    const full = join(dir, entry);

    let stat;
    try {
      stat = lstatSync(full);
    } catch {
      continue;
    }

    // If symlink, resolve realpath and skip if outside root
    if (stat.isSymbolicLink()) {
      try {
        const real = realpathSync(full);
        const normalizedReal = normalizePath(real);
        const normalizedRoot = normalizePath(root);
        if (!normalizedReal.startsWith(normalizedRoot + "/") && normalizedReal !== normalizedRoot) {
          continue;
        }
        stat = statSync(full);
      } catch {
        continue;
      }
    }

    const relPath = full.slice(root.length + 1);

    if (stat.isDirectory()) {
      // If pattern has **, recurse always; otherwise only recurse into matching segments
      globWalk(full, pattern, root, results, limit);
    } else {
      if (globMatch(pattern, relPath)) {
        results.push(full);
      }
    }
  }
}

/**
 * Simple glob matching supporting *, **, and ?
 * Converts glob pattern to regex for matching.
 */
function globMatch(pattern: string, filePath: string): boolean {
  // Normalize separators
  const normalizedPattern = pattern.replace(/\\/g, "/");
  const normalizedPath = filePath.replace(/\\/g, "/");

  const regexStr = globToRegex(normalizedPattern);
  try {
    const re = new RegExp(`^${regexStr}$`, IS_MACOS || IS_WINDOWS ? "i" : "");
    return re.test(normalizedPath);
  } catch {
    return false;
  }
}

function globToRegex(pattern: string): string {
  let result = "";
  let i = 0;

  while (i < pattern.length) {
    const ch = pattern[i];

    if (ch === "*" && pattern[i + 1] === "*") {
      // **/ or ** at end
      if (pattern[i + 2] === "/") {
        result += "(?:.+/)?";
        i += 3;
      } else {
        result += ".*";
        i += 2;
      }
    } else if (ch === "*") {
      result += "[^/]*";
      i++;
    } else if (ch === "?") {
      result += "[^/]";
      i++;
    } else if (ch === "{") {
      const closeBrace = pattern.indexOf("}", i);
      if (closeBrace !== -1) {
        const alternatives = pattern.slice(i + 1, closeBrace).split(",");
        result += "(?:" + alternatives.map(escapeRegex).join("|") + ")";
        i = closeBrace + 1;
      } else {
        result += escapeRegex(ch);
        i++;
      }
    } else {
      result += escapeRegex(ch);
      i++;
    }
  }

  return result;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// -- bash --

async function handleBash(
  callId: string,
  args: { command: string; timeout?: number; cwd?: string },
): Promise<ToolResult> {
  if (config.readOnly) return { success: false, output: "", error: "Read-only mode: bash is disabled" };

  // C3: Block .env file access in commands
  const envPattern = /(?:^|[^a-zA-Z0-9_.])\.env(?!\.[a-zA-Z]*example)(?:\.[a-zA-Z0-9_]*)?(?:[^a-zA-Z0-9_.]|$)/;
  if (envPattern.test(args.command)) {
    return { success: false, output: "", error: "Access to .env files is blocked" };
  }

  const cwd = args.cwd || config.projectRoot;
  const cwdValidation = validatePath(cwd, config.projectRoot);
  if (!cwdValidation.ok) return { success: false, output: "", error: cwdValidation.error };

  // H4: Default bash timeout to 5 minutes, not config.timeout (30s)
  const timeoutMs = args.timeout || 300_000;
  const shell = resolveShell(args.command);
  const spawnOpts = getSpawnOptions(cwdValidation.resolved);

  return new Promise((resolve) => {
    const proc = spawn(shell.exe, shell.args, spawnOpts);

    if (!proc.pid) {
      resolve({ success: false, output: "", error: "Failed to spawn process" });
      return;
    }

    activeProcesses.set(callId, proc);

    let stdout = "";
    let stderr = "";
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      if (proc.pid) killProcessTree(proc.pid);
    }, timeoutMs);

    proc.stdout!.on("data", (d: Buffer) => {
      const chunk = d.toString();
      stdout += chunk;
      wsSend({ type: "stdout", id: callId, data: sanitizeSecrets(chunk) });
    });

    proc.stderr!.on("data", (d: Buffer) => {
      const chunk = d.toString();
      stderr += chunk;
      wsSend({ type: "stderr", id: callId, data: sanitizeSecrets(chunk) });
    });

    proc.on("close", (code) => {
      clearTimeout(timer);
      activeProcesses.delete(callId);

      // M4: If this call was cancelled, skip sending result (already sent "cancelled")
      if (cancelledCalls.has(callId)) {
        cancelledCalls.delete(callId);
        resolve({ success: false, output: "", error: "Cancelled" });
        return;
      }

      wsSend({ type: "stream_end", id: callId });

      const output = sanitizeSecrets(truncateOutput(stdout));
      if (timedOut) {
        resolve({ success: false, output, error: `Command timed out after ${timeoutMs}ms` });
      } else {
        resolve({
          success: code === 0,
          output,
          error: code !== 0 ? sanitizeSecrets(stderr.slice(0, 500)) : undefined,
        });
      }
    });

    proc.on("error", (e) => {
      clearTimeout(timer);
      activeProcesses.delete(callId);
      resolve({ success: false, output: "", error: e.message });
    });
  });
}

// ---------------------------------------------------------------------------
// 8. Tool schemas
// ---------------------------------------------------------------------------

const TOOL_SCHEMAS: ToolSchema[] = [
  {
    name: "view",
    description: "View file contents with line numbers or list directory contents",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Absolute path to file or directory" },
        start_line: { type: "number", description: "Start line number (1-indexed)" },
        end_line: { type: "number", description: "End line number (1-indexed)" },
      },
      required: ["path"],
    },
  },
  {
    name: "edit",
    description: "Replace exactly one occurrence of old_str with new_str in a file",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Absolute path to the file" },
        old_str: { type: "string", description: "Exact string to find (must be unique)" },
        new_str: { type: "string", description: "Replacement string" },
      },
      required: ["path", "old_str", "new_str"],
    },
  },
  {
    name: "create",
    description: "Create a new file with the given content. File must not already exist.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Absolute path for the new file" },
        content: { type: "string", description: "File content" },
      },
      required: ["path", "content"],
    },
  },
  {
    name: "grep",
    description: "Search file contents using ripgrep or grep. Returns matching lines.",
    inputSchema: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "Regex pattern to search for" },
        path: { type: "string", description: "File or directory to search in" },
        glob: { type: "string", description: "Glob pattern to filter files" },
        context: { type: "number", description: "Lines of context around matches" },
      },
      required: ["pattern"],
    },
  },
  {
    name: "glob",
    description: "Find files by name using glob patterns (e.g. **/*.ts)",
    inputSchema: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "Glob pattern (e.g. **/*.ts, src/**/*.js)" },
        path: { type: "string", description: "Base directory to search in" },
      },
      required: ["pattern"],
    },
  },
  {
    name: "bash",
    description: "Run a bash command. Output is streamed back.",
    inputSchema: {
      type: "object",
      properties: {
        command: { type: "string", description: "Shell command to execute" },
        timeout: { type: "number", description: "Timeout in milliseconds" },
        cwd: { type: "string", description: "Working directory" },
      },
      required: ["command"],
    },
  },
];

// ---------------------------------------------------------------------------
// 9. WebSocket client + message handling
// ---------------------------------------------------------------------------

let ws: WebSocket | null = null;
let reconnectDelay = 1000;
const sessionId = randomUUID();
let activeCalls = 0;

function wsSend(msg: any): void {
  if (ws?.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg));
  }
}

function connect(): void {
  const wsUrl = `${config.server}/worker/ws?name=${encodeURIComponent(config.name)}&token=${encodeURIComponent(config.token)}`;

  // H5: WHATWG WebSocket doesn't accept `ca` option.
  // Use NODE_EXTRA_CA_CERTS env var instead (must be set before first TLS handshake).
  if (config.caCert) {
    try {
      // Verify the file is readable
      readFileSync(config.caCert);
      process.env.NODE_EXTRA_CA_CERTS = config.caCert;
    } catch (e: any) {
      console.error(`[worker] Failed to read CA cert: ${e.message}`);
    }
  }

  // WHATWG WebSocket supports protocols as 2nd arg but not headers.
  // Bun's WebSocket supports a headers option; Node's does not.
  const wsOpts: any = {};
  const extraHeaders: Record<string, string> = {
    "User-Agent": "Clawd-RemoteWorker/0.1",
  };
  if (config.cfClientId && config.cfClientSecret) {
    extraHeaders["CF-Access-Client-Id"] = config.cfClientId;
    extraHeaders["CF-Access-Client-Secret"] = config.cfClientSecret;
  }
  // Bun supports headers in WebSocket constructor options
  if (typeof Bun !== "undefined") {
    wsOpts.headers = extraHeaders;
  }

  ws = new WebSocket(wsUrl);

  ws.onopen = () => {
    console.log("[worker] Connected to server");
    reconnectDelay = 1000;

    wsSend({
      type: "register",
      name: config.name,
      projectRoot: config.projectRoot,
      platform: process.platform,
      sessionId,
      maxConcurrent: config.maxConcurrent,
      tools: TOOL_SCHEMAS,
      version: "0.1.0",
    });

    startHeartbeat();
  };

  ws.onmessage = (event: MessageEvent) => {
    handleMessage(typeof event.data === "string" ? event.data : String(event.data));
  };

  ws.onclose = () => {
    stopHeartbeat();
    reconnect();
  };

  ws.onerror = (e: Event) => {
    console.error("[worker] WS error:", (e as any).message || e);
  };
}

function handleMessage(raw: string): void {
  let msg: any;
  try {
    msg = JSON.parse(raw);
  } catch {
    console.error("[worker] Invalid JSON from server");
    return;
  }

  switch (msg.type) {
    case "registered":
      if (msg.error) {
        console.error(`[worker] Registration failed: ${msg.error}`);
      } else {
        console.log(`[worker] Registered successfully (session: ${sessionId})`);
      }
      break;

    case "call":
      if (activeCalls >= config.maxConcurrent) {
        wsSend({ type: "error", id: msg.id, error: "Max concurrent calls exceeded" });
        return;
      }
      activeCalls++;
      handleToolCall(msg).finally(() => {
        activeCalls--;
      });
      break;

    case "cancel": {
      // M4: Mark as cancelled before killing to prevent double-send
      cancelledCalls.add(msg.id);
      const proc = activeProcesses.get(msg.id);
      if (proc?.pid) {
        killProcessTree(proc.pid);
        activeProcesses.delete(msg.id);
      }
      wsSend({ type: "cancelled", id: msg.id });
      break;
    }

    case "pong":
      lastPong = Date.now();
      break;

    case "shutdown":
      console.log("[worker] Server requested shutdown");
      for (const [id, proc] of activeProcesses) {
        if (proc.pid) killProcessTree(proc.pid);
        activeProcesses.delete(id);
      }
      wsSend({ type: "shutdown_ack" });
      setTimeout(() => process.exit(0), 500);
      break;

    default:
      // Ignore unknown message types
      break;
  }
}

async function handleToolCall(msg: { id: string; tool: string; args: any }): Promise<void> {
  let result: ToolResult;
  try {
    switch (msg.tool) {
      case "view":
        result = await handleView(msg.args);
        break;
      case "edit":
        result = await handleEdit(msg.args);
        break;
      case "create":
        result = await handleCreate(msg.args);
        break;
      case "grep":
        result = await handleGrep(msg.args);
        break;
      case "glob":
        result = await handleGlob(msg.args);
        break;
      case "bash":
        result = await handleBash(msg.id, msg.args);
        break;
      default:
        result = { success: false, output: "", error: `Unknown tool: ${msg.tool}` };
    }
    wsSend({ type: "result", id: msg.id, result });
  } catch (e: any) {
    wsSend({ type: "error", id: msg.id, error: e.message });
  }
}

// ---------------------------------------------------------------------------
// 10. Heartbeat
// ---------------------------------------------------------------------------

let heartbeatInterval: ReturnType<typeof setInterval> | null = null;
let lastPong = Date.now();

function startHeartbeat(): void {
  stopHeartbeat();
  heartbeatInterval = setInterval(() => {
    wsSend({ type: "ping", ts: Date.now() });
    if (Date.now() - lastPong > 60_000) {
      console.warn("[worker] No pong received — reconnecting");
      ws?.close();
    }
  }, 30_000);
}

function stopHeartbeat(): void {
  if (heartbeatInterval) {
    clearInterval(heartbeatInterval);
    heartbeatInterval = null;
  }
}

// ---------------------------------------------------------------------------
// 11. Reconnect with exponential backoff
// ---------------------------------------------------------------------------

function reconnect(): void {
  console.log(`[worker] Reconnecting in ${reconnectDelay / 1000}s...`);
  setTimeout(() => {
    connect();
    reconnectDelay = Math.min(reconnectDelay * 2, config.reconnectMax * 1000);
  }, reconnectDelay);
}

// ---------------------------------------------------------------------------
// 12. Startup diagnostics + TLS setup + main entry
// ---------------------------------------------------------------------------

// TLS setup
if (config.insecure) {
  console.warn("⚠️  TLS verification DISABLED — NOT for production!");
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
}

// Startup diagnostics
console.log(`[worker] Platform: ${process.platform} (${process.arch})`);
if (IS_WSL2) console.log("[worker] Running inside WSL2");
if (IS_MACOS) console.log("[worker] macOS APFS (case-insensitive path comparison active)");
console.log(`[worker] Project root: ${config.projectRoot}`);
console.log(`[worker] Server: ${config.server}`);
console.log(`[worker] Name: ${config.name}`);
console.log(`[worker] Read-only: ${config.readOnly}`);
console.log(`[worker] Max concurrent: ${config.maxConcurrent}`);

// Graceful shutdown
process.on("SIGINT", () => {
  console.log("\n[worker] Shutting down...");
  for (const [, proc] of activeProcesses) {
    if (proc.pid) killProcessTree(proc.pid);
  }
  wsSend({ type: "shutdown" });
  setTimeout(() => process.exit(0), 500);
});

process.on("SIGTERM", () => {
  for (const [, proc] of activeProcesses) {
    if (proc.pid) killProcessTree(proc.pid);
  }
  wsSend({ type: "shutdown" });
  setTimeout(() => process.exit(0), 500);
});

// Start connection
connect();
