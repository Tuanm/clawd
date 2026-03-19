#!/usr/bin/env -S npx tsx

/**
 * Claw'd Remote Worker — single-file TypeScript worker
 * Connects to a Claw'd server via WebSocket and executes file tools on the remote machine.
 * Runs with Bun or Node.js 22.4+. ZERO external dependencies.
 */

import { type ChildProcess, execSync, type SpawnOptions, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { basename, delimiter, dirname, join, resolve as pathResolve, sep } from "node:path";

// ---------------------------------------------------------------------------
// 1. Type definitions
// ---------------------------------------------------------------------------

interface ToolResult {
  success: boolean;
  output: string;
  error?: string;
  mimeType?: string;
  isBase64?: boolean;
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

function detectDefaultBrowser(): "chrome" | "edge" | null {
  try {
    if (IS_WINDOWS) {
      const output = execSync(
        'reg query "HKCU\\Software\\Microsoft\\Windows\\Shell\\Associations\\UrlAssociations\\http\\UserChoice" /v ProgId',
        { encoding: "utf-8", timeout: 5000 },
      ).toLowerCase();
      if (output.includes("chromehtml")) return "chrome";
      if (output.includes("msedgehtm")) return "edge";
    } else if (IS_MACOS) {
      const output = execSync("/usr/bin/open -Ra http://example.com", {
        encoding: "utf-8",
        timeout: 5000,
      }).toLowerCase();
      if (output.includes("microsoft edge")) return "edge";
      if (output.includes("google chrome")) return "chrome";
    }
  } catch {}
  return null;
}

function findChromeBinary(): string | null {
  const defaultBrowser = detectDefaultBrowser();
  if (IS_WINDOWS) {
    const chromePaths = [
      join(process.env.PROGRAMFILES || "", "Google", "Chrome", "Application", "chrome.exe"),
      join(process.env["PROGRAMFILES(X86)"] || "", "Google", "Chrome", "Application", "chrome.exe"),
      join(process.env.LOCALAPPDATA || "", "Google", "Chrome", "Application", "chrome.exe"),
    ];
    const edgePaths = [join(process.env.PROGRAMFILES || "", "Microsoft", "Edge", "Application", "msedge.exe")];
    // Prefer Edge only if it's the detected default
    const paths = defaultBrowser === "edge" ? [...edgePaths, ...chromePaths] : [...chromePaths, ...edgePaths];
    for (const p of paths) {
      if (existsSync(p)) return p;
    }
    return null;
  }
  if (IS_MACOS) {
    const chromePaths = [
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary",
      "/Applications/Chromium.app/Contents/MacOS/Chromium",
    ];
    const edgePaths = ["/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"];
    // Put Edge first on macOS by default; only put Chrome first if it's the detected default
    const paths = defaultBrowser === "chrome" ? [...chromePaths, ...edgePaths] : [...edgePaths, ...chromePaths];
    for (const p of paths) {
      if (existsSync(p)) return p;
    }
  }
  // Linux / WSL2 / fallback
  const names = ["google-chrome-stable", "google-chrome", "chromium-browser", "chromium", "microsoft-edge-stable"];
  for (const name of names) {
    try {
      const p = execSync(`which ${name}`, { encoding: "utf-8" }).trim();
      if (p) return p;
    } catch {}
  }
  return null;
}

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
  browser: boolean;
  browserProfile: string | null;
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
  --browser [profile]    Enable CDP browser control (default: temp profile)
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
  let browser = false;
  let browserProfile: string | null = null;

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
      case "--browser":
        browser = true;
        // Next arg is profile name if it doesn't start with --
        if (i + 1 < argv.length && !argv[i + 1].startsWith("--")) {
          browserProfile = argv[++i];
        }
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
    browser,
    browserProfile,
  };
}

const config = parseArgs();
let chromeManager: ChromeManager | null = null;
const scriptStore = new Map<string, { code: string; description: string }>();
const STORE_MAX_SCRIPTS = 100;
const STORE_MAX_SCRIPT_SIZE = 1_000_000; // 1MB
const STORE_MAX_KEY_LEN = 256;

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

  // Use native Windows shell — no Git Bash conversion needed.
  // Agent should write OS-native commands (PowerShell/cmd syntax).
  for (const ps of ["pwsh.exe", "powershell.exe"]) {
    try {
      execSync(`where ${ps}`, { stdio: "ignore" });
      return { exe: ps, args: ["-NoProfile", "-NonInteractive", "-Command", command] };
    } catch {
      // try next
    }
  }
  return { exe: process.env.ComSpec || "cmd.exe", args: ["/c", command] };
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
  if (!v.ok) return { success: false, output: "", error: (v as any).error };

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
  if (!v.ok) return { success: false, output: "", error: (v as any).error };

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
  if (!v.ok) return { success: false, output: "", error: (v as any).error };

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
  if (!v.ok) return { success: false, output: "", error: (v as any).error };

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
  if (!v.ok) return { success: false, output: "", error: (v as any).error };

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
  if (!cwdValidation.ok) return { success: false, output: "", error: (cwdValidation as any).error };

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
// 8b. CDP Client — raw Chrome DevTools Protocol over WebSocket
// ---------------------------------------------------------------------------

interface CDPResponse {
  id?: number;
  result?: any;
  error?: { code: number; message: string };
  method?: string;
  params?: any;
  sessionId?: string;
}

class CDPClient {
  private ws: WebSocket | null = null;
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  private listeners = new Map<string, Array<(params: any) => void>>();
  private connected = false;

  async connect(wsUrl: string): Promise<void> {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(wsUrl);
      this.ws.onopen = () => {
        this.connected = true;
        resolve();
      };
      this.ws.onmessage = (event: MessageEvent) => {
        this.handleMessage(typeof event.data === "string" ? event.data : String(event.data));
      };
      this.ws.onclose = () => {
        this.connected = false;
        this.rejectAll("CDP connection closed");
      };
      this.ws.onerror = (e: Event) => reject(new Error("CDP connection failed"));
      setTimeout(() => reject(new Error("CDP connection timeout")), 10000);
    });
  }

  private handleMessage(raw: string): void {
    let msg: CDPResponse;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }

    if (msg.id !== undefined) {
      const p = this.pending.get(msg.id);
      if (p) {
        this.pending.delete(msg.id);
        if (msg.error) p.reject(new Error(`CDP error: ${msg.error.message}`));
        else p.resolve(msg.result || {});
      }
    } else if (msg.method) {
      const cbs = this.listeners.get(msg.method);
      if (cbs) cbs.forEach((cb) => cb(msg.params || {}));
    }
  }

  async send(method: string, params: Record<string, any> = {}, sessionId?: string): Promise<any> {
    if (!this.ws || !this.connected) throw new Error("CDP not connected");
    const id = this.nextId++;
    const msg: any = { id, method, params };
    if (sessionId) msg.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws!.send(JSON.stringify(msg));
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`CDP timeout: ${method}`));
        }
      }, 60000);
    });
  }

  on(event: string, callback: (params: any) => void): void {
    if (!this.listeners.has(event)) this.listeners.set(event, []);
    this.listeners.get(event)!.push(callback);
  }

  off(event: string, callback?: (params: any) => void): void {
    if (!callback) {
      this.listeners.delete(event);
      return;
    }
    const cbs = this.listeners.get(event);
    if (cbs)
      this.listeners.set(
        event,
        cbs.filter((cb) => cb !== callback),
      );
  }

  private rejectAll(reason: string): void {
    for (const [id, p] of this.pending) {
      p.reject(new Error(reason));
    }
    this.pending.clear();
  }

  close(): void {
    this.connected = false;
    try {
      this.ws?.close();
    } catch {}
    this.rejectAll("CDP client closed");
  }

  get isConnected(): boolean {
    return this.connected;
  }
}

class ChromeManager {
  private process: ChildProcess | null = null;
  private cdp: CDPClient | null = null;
  private profileDir: string;
  private port: number;
  private pageSessionId: string | null = null;
  private pendingDialogs: Array<{ message: string; type: string; defaultPrompt?: string }> = [];
  private authQueue: Array<{ requestId: string; url: string; scheme: string; realm: string }> = [];
  private downloads: Array<{
    guid: string;
    url: string;
    filename: string;
    state: string;
    totalBytes: number;
    receivedBytes: number;
    path?: string;
  }> = [];
  private downloadPath: string;

  constructor(profile: string | null) {
    if (profile) {
      const home = process.env.HOME || process.env.USERPROFILE || "/tmp";
      this.profileDir = join(home, ".clawd", "browser-profiles", profile);
    } else {
      this.profileDir = join(REAL_TMP, `clawd-browser-${process.pid}`);
    }
    this.port = 9222 + (process.pid % 1000); // Avoid port conflicts between workers
    this.downloadPath = join(REAL_TMP, `clawd-downloads-${process.pid}`);
  }

  async launch(): Promise<void> {
    const binary = findChromeBinary();
    if (!binary) throw new Error("Chrome/Chromium not found. Install Chrome or use --browser-path.");

    const { mkdirSync } = await import("node:fs");
    mkdirSync(this.profileDir, { recursive: true });

    const hasDisplay = !!process.env.DISPLAY || !!process.env.WAYLAND_DISPLAY || IS_WINDOWS || IS_MACOS;

    const args = [
      `--remote-debugging-port=${this.port}`,
      `--user-data-dir=${this.profileDir}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-background-networking",
      "--disable-default-apps",
      "--disable-sync",
      "--disable-features=TranslateUI",
    ];
    if (!hasDisplay) args.push("--headless=new");
    if (!IS_MACOS && !IS_WINDOWS) args.push("--no-sandbox");

    console.log(`[browser] Launching Chrome: ${binary}`);
    console.log(`[browser] Profile: ${this.profileDir}`);
    console.log(`[browser] CDP port: ${this.port}`);
    if (!hasDisplay) console.log("[browser] Headless mode (no DISPLAY)");

    this.process = spawn(binary, args, { stdio: "ignore", detached: !IS_WINDOWS });

    // Wait for CDP port to be ready
    const wsUrl = await this.waitForCDP();
    console.log(`[browser] CDP ready: ${wsUrl}`);

    // Connect CDP client
    this.cdp = new CDPClient();
    await this.cdp.connect(wsUrl);

    // Enable required domains
    await this.enableDomains();
  }

  private async waitForCDP(timeout = 30000): Promise<string> {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      try {
        const resp = await fetch(`http://127.0.0.1:${this.port}/json/version`);
        if (resp.ok) {
          const data = (await resp.json()) as any;
          return data.webSocketDebuggerUrl;
        }
      } catch {}
      await new Promise((r) => setTimeout(r, 500));
    }
    throw new Error(`Chrome failed to start (CDP port ${this.port} not ready after ${timeout}ms)`);
  }

  private async enableDomains(): Promise<void> {
    // Discover existing page targets, attach to first one
    const { targetInfos } = await this.cdp!.send("Target.getTargets");
    const page = targetInfos.find((t: any) => t.type === "page");
    if (page) {
      const { sessionId } = await this.cdp!.send("Target.attachToTarget", { targetId: page.targetId, flatten: true });
      this.pageSessionId = sessionId;
    } else {
      // Create a new page
      const { targetId } = await this.cdp!.send("Target.createTarget", { url: "about:blank" });
      const { sessionId } = await this.cdp!.send("Target.attachToTarget", { targetId, flatten: true });
      this.pageSessionId = sessionId;
    }

    // Enable domains on the page session
    await this.pageSend("Page.enable");
    await this.pageSend("Runtime.enable");
    await this.pageSend("DOM.enable");
    await this.pageSend("Network.enable");
    // Listen for dialogs
    this.cdp!.on("Page.javascriptDialogOpening", (params) => {
      this.pendingDialogs.push({ message: params.message, type: params.type, defaultPrompt: params.defaultPrompt });
    });
    // Register Fetch handlers BEFORE enabling to avoid race condition
    this.cdp!.on("Fetch.authRequired", (params) => {
      this.authQueue.push({
        requestId: params.requestId,
        url: params.request?.url || "",
        scheme: params.authChallenge?.scheme || "",
        realm: params.authChallenge?.realm || "",
      });
    });
    this.cdp!.on("Fetch.requestPaused", async (params) => {
      // Continue non-auth paused requests transparently
      try {
        await this.pageSend("Fetch.continueRequest", { requestId: params.requestId });
      } catch {}
    });
    // Enable Fetch for HTTP auth interception (after handlers registered)
    await this.pageSend("Fetch.enable", { handleAuthRequests: true }).catch(() => {});

    // Listen for new targets (tabs)
    await this.cdp!.send("Target.setDiscoverTargets", { discover: true });

    // Configure downloads
    const { mkdirSync: mkdirSyncDl } = await import("node:fs");
    mkdirSyncDl(this.downloadPath, { recursive: true });
    await this.cdp!.send("Browser.setDownloadBehavior", {
      behavior: "allowAndName",
      downloadPath: this.downloadPath,
      eventsEnabled: true,
    });
    this.cdp!.on("Browser.downloadWillBegin", (params) => {
      this.downloads.push({
        guid: params.guid,
        url: params.url,
        filename: params.suggestedFilename,
        state: "inProgress",
        totalBytes: 0,
        receivedBytes: 0,
      });
      // Cap at 100 entries
      if (this.downloads.length > 100) this.downloads.splice(0, this.downloads.length - 100);
    });
    this.cdp!.on("Browser.downloadProgress", (params) => {
      const dl = this.downloads.find((d) => d.guid === params.guid);
      if (dl) {
        dl.state = params.state;
        dl.totalBytes = params.totalBytes;
        dl.receivedBytes = params.receivedBytes;
        if (params.state === "completed") {
          const safeName = dl.filename.replace(/[/\\]/g, "_") || "download";
          dl.path = join(this.downloadPath, safeName);
        }
      }
    });
  }

  async pageSend(method: string, params: Record<string, any> = {}): Promise<any> {
    if (!this.cdp || !this.pageSessionId) throw new Error("No active page session");
    return this.cdp.send(method, params, this.pageSessionId);
  }

  async switchToTarget(targetId: string): Promise<void> {
    if (this.pageSessionId) {
      try {
        await this.cdp!.send("Target.detachFromTarget", { sessionId: this.pageSessionId });
      } catch {}
    }
    const { sessionId } = await this.cdp!.send("Target.attachToTarget", { targetId, flatten: true });
    this.pageSessionId = sessionId;
    await this.pageSend("Page.enable");
    await this.pageSend("Runtime.enable");
    await this.pageSend("DOM.enable");
    await this.pageSend("Network.enable").catch(() => {});
    await this.pageSend("Fetch.enable", { handleAuthRequests: true }).catch(() => {});
  }

  getCdp(): CDPClient | null {
    return this.cdp;
  }
  getPageSessionId(): string | null {
    return this.pageSessionId;
  }
  getPendingDialogs() {
    return this.pendingDialogs;
  }
  getAuthQueue() {
    return this.authQueue;
  }
  popAuth() {
    return this.authQueue.shift();
  }
  getDownloads() {
    return this.downloads;
  }
  getDownloadPath() {
    return this.downloadPath;
  }
  setDownloadPath(p: string) {
    this.downloadPath = p;
  }

  async shutdown(): Promise<void> {
    if (this.cdp) {
      try {
        await this.cdp.send("Browser.close");
      } catch {}
      this.cdp.close();
      this.cdp = null;
    }
    if (this.process) {
      try {
        this.process.kill();
      } catch {}
      this.process = null;
    }
  }
}

// CDP helper: resolve CSS selector to node coordinates
async function resolveSelector(
  chrome: ChromeManager,
  selector: string,
): Promise<{ x: number; y: number; nodeId: number }> {
  const { root } = await chrome.pageSend("DOM.getDocument");
  const { nodeId } = await chrome.pageSend("DOM.querySelector", { nodeId: root.nodeId, selector });
  if (!nodeId) throw new Error(`Element not found: ${selector}`);
  const { model } = await chrome.pageSend("DOM.getBoxModel", { nodeId });
  // content quad: [x1,y1, x2,y2, x3,y3, x4,y4]
  const q = model.content;
  const x = (q[0] + q[2] + q[4] + q[6]) / 4;
  const y = (q[1] + q[3] + q[5] + q[7]) / 4;
  return { x, y, nodeId };
}

// CDP helper: evaluate JavaScript in page context
async function cdpEvaluate(chrome: ChromeManager, expression: string): Promise<any> {
  const result = await chrome.pageSend("Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.text || "JS evaluation error");
  }
  return result.result?.value;
}

// ---------------------------------------------------------------------------
// 8c. Browser tool handlers
// ---------------------------------------------------------------------------

let _ensureBrowserLock: Promise<void> | null = null;

async function ensureBrowser(): Promise<void> {
  if (_ensureBrowserLock) return _ensureBrowserLock;
  _ensureBrowserLock = _ensureBrowserInner().finally(() => {
    _ensureBrowserLock = null;
  });
  return _ensureBrowserLock;
}

async function _ensureBrowserInner(): Promise<void> {
  if (!config.browser) throw new Error("Browser not enabled");
  if (chromeManager && chromeManager.getCdp()?.isConnected) {
    try {
      await Promise.race([
        chromeManager.getCdp()!.send("Browser.getVersion"),
        new Promise((_, reject) => setTimeout(() => reject(new Error("Health check timeout")), 3000)),
      ]);
      return;
    } catch {
      await chromeManager.shutdown().catch(() => {});
      chromeManager = null;
    }
  }
  if (!chromeManager) {
    chromeManager = new ChromeManager(config.browserProfile);
    await chromeManager.launch();
  }
}

async function handleBrowserStatus(): Promise<ToolResult> {
  if (!chromeManager?.getCdp()?.isConnected) {
    return { success: true, output: JSON.stringify({ connected: false, message: "Browser not running" }) };
  }
  try {
    const version = await chromeManager.getCdp()!.send("Browser.getVersion");
    return {
      success: true,
      output: JSON.stringify(
        {
          connected: true,
          browser: version.product,
          protocol: version.protocolVersion,
          userAgent: version.userAgent,
        },
        null,
        2,
      ),
    };
  } catch (e: any) {
    return { success: false, output: "", error: e.message };
  }
}

async function handleBrowserNavigate(args: { url: string; tab_id?: string }): Promise<ToolResult> {
  if (!chromeManager) return { success: false, output: "", error: "Browser not available" };
  if (args.url.toLowerCase().startsWith("file://")) {
    return { success: false, output: "", error: "file:// URLs are not allowed" };
  }
  try {
    if (args.tab_id) await chromeManager.switchToTarget(args.tab_id);
    await chromeManager.pageSend("Page.navigate", { url: args.url });
    // Poll for page load completion instead of event listener (avoids listener leak)
    let loaded = false;
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) {
      try {
        const state = await cdpEvaluate(chromeManager, "document.readyState");
        if (state === "complete") {
          loaded = true;
          break;
        }
      } catch {}
      await new Promise((r) => setTimeout(r, 300));
    }
    const { result: titleResult } = await chromeManager.pageSend("Runtime.evaluate", {
      expression: "document.title",
      returnByValue: true,
    });
    const { result: urlResult } = await chromeManager.pageSend("Runtime.evaluate", {
      expression: "window.location.href",
      returnByValue: true,
    });
    const result: Record<string, any> = { url: urlResult?.value, title: titleResult?.value };
    if (!loaded) result.warning = "Page did not fully load within 30s";
    return {
      success: true,
      output: JSON.stringify(result, null, 2),
    };
  } catch (e: any) {
    return { success: false, output: "", error: e.message };
  }
}

async function handleBrowserScreenshot(args: {
  selector?: string;
  full_page?: boolean;
  quality?: number;
}): Promise<ToolResult> {
  if (!chromeManager) return { success: false, output: "", error: "Browser not available" };
  try {
    const params: any = { format: "jpeg", quality: args.quality ?? 80 };
    if (args.selector) {
      const { x, y, nodeId: _ } = await resolveSelector(chromeManager, args.selector);
      const { model } = await chromeManager.pageSend("DOM.getBoxModel", { nodeId: _ });
      const q = model.content;
      params.clip = {
        x: Math.min(q[0], q[2], q[4], q[6]),
        y: Math.min(q[1], q[3], q[5], q[7]),
        width: Math.max(q[0], q[2], q[4], q[6]) - Math.min(q[0], q[2], q[4], q[6]),
        height: Math.max(q[1], q[3], q[5], q[7]) - Math.min(q[1], q[3], q[5], q[7]),
        scale: 1,
      };
    }
    if (args.full_page) params.captureBeyondViewport = true;
    const { data } = await chromeManager.pageSend("Page.captureScreenshot", params);
    return {
      success: true,
      output: data,
      mimeType: "image/jpeg",
      isBase64: true,
    };
  } catch (e: any) {
    return { success: false, output: "", error: e.message };
  }
}

async function handleBrowserClick(args: {
  selector?: string;
  x?: number;
  y?: number;
  button?: string;
  double?: boolean;
}): Promise<ToolResult> {
  if (!chromeManager) return { success: false, output: "", error: "Browser not available" };
  try {
    let cx: number, cy: number;
    if (args.selector) {
      const pos = await resolveSelector(chromeManager, args.selector);
      cx = pos.x;
      cy = pos.y;
    } else if (args.x !== undefined && args.y !== undefined) {
      cx = args.x;
      cy = args.y;
    } else {
      return { success: false, output: "", error: "Provide selector or x,y coordinates" };
    }
    const button = args.button || "left";
    const clickCount = args.double ? 2 : 1;
    const buttons = button === "right" ? 2 : button === "middle" ? 4 : 1;
    // Move mouse to target before clicking
    await chromeManager.pageSend("Input.dispatchMouseEvent", { type: "mouseMoved", x: cx, y: cy });
    // Mouse press + release
    await chromeManager.pageSend("Input.dispatchMouseEvent", {
      type: "mousePressed",
      x: cx,
      y: cy,
      button,
      buttons,
      clickCount,
    });
    await chromeManager.pageSend("Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x: cx,
      y: cy,
      button,
      buttons: 0,
      clickCount,
    });
    return {
      success: true,
      output: JSON.stringify({ clicked: true, x: cx, y: cy, button, double: args.double || false }, null, 2),
    };
  } catch (e: any) {
    return { success: false, output: "", error: e.message };
  }
}

async function handleBrowserType(args: {
  text: string;
  selector?: string;
  clear?: boolean;
  submit?: boolean;
}): Promise<ToolResult> {
  if (!chromeManager) return { success: false, output: "", error: "Browser not available" };
  try {
    if (args.selector) {
      const pos = await resolveSelector(chromeManager, args.selector);
      await chromeManager.pageSend("Input.dispatchMouseEvent", {
        type: "mousePressed",
        x: pos.x,
        y: pos.y,
        button: "left",
        buttons: 1,
        clickCount: 1,
      });
      await chromeManager.pageSend("Input.dispatchMouseEvent", {
        type: "mouseReleased",
        x: pos.x,
        y: pos.y,
        button: "left",
        buttons: 0,
        clickCount: 1,
      });
    }
    if (args.clear) {
      // Select all + delete
      await chromeManager.pageSend("Input.dispatchKeyEvent", {
        type: "keyDown",
        key: "a",
        code: "KeyA",
        modifiers: IS_MACOS ? 4 : 2,
      });
      await chromeManager.pageSend("Input.dispatchKeyEvent", { type: "keyUp", key: "a", code: "KeyA" });
      await chromeManager.pageSend("Input.dispatchKeyEvent", { type: "keyDown", key: "Backspace", code: "Backspace" });
      await chromeManager.pageSend("Input.dispatchKeyEvent", { type: "keyUp", key: "Backspace", code: "Backspace" });
    }
    await chromeManager.pageSend("Input.insertText", { text: args.text });
    if (args.submit) {
      await chromeManager.pageSend("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter" });
      await chromeManager.pageSend("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter" });
    }
    return {
      success: true,
      output: JSON.stringify({ typed: true, text_length: args.text.length }, null, 2),
    };
  } catch (e: any) {
    return { success: false, output: "", error: e.message };
  }
}

async function handleBrowserExtract(args: { mode: string; selector?: string }): Promise<ToolResult> {
  if (!chromeManager) return { success: false, output: "", error: "Browser not available" };
  try {
    const scope = args.selector ? `document.querySelector(${JSON.stringify(args.selector)})` : "document.body";
    let expression: string;
    switch (args.mode) {
      case "text":
        expression = `(${scope})?.innerText || ""`;
        break;
      case "html":
        expression = `(${scope})?.innerHTML || ""`;
        break;
      case "links":
        expression = `JSON.stringify(Array.from((${scope})?.querySelectorAll("a[href]") || []).map(a => ({ text: a.textContent?.trim(), href: a.href })).filter(l => l.href))`;
        break;
      case "forms":
        expression = `JSON.stringify(Array.from((${scope})?.querySelectorAll("input,textarea,select,button") || []).map(el => ({ tag: el.tagName, type: el.type, name: el.name, id: el.id, value: el.value || "", placeholder: el.placeholder || "" })))`;
        break;
      case "tables":
        expression = `JSON.stringify(Array.from((${scope})?.querySelectorAll("table") || []).map(t => Array.from(t.rows).map(r => Array.from(r.cells).map(c => c.textContent?.trim()))))`;
        break;
      case "accessibility":
        expression = `(function walk(el, depth) {
          if (!el || depth > 5) return [];
          const items = [];
          for (const child of el.children || []) {
            const role = child.getAttribute("role") || child.tagName.toLowerCase();
            const label = child.getAttribute("aria-label") || child.textContent?.trim()?.slice(0, 80) || "";
            if (label) items.push({ role, label, tag: child.tagName });
            items.push(...walk(child, depth + 1));
          }
          return items;
        })(${scope}, 0).slice(0, 200);\nJSON.stringify(arguments[0] || [])`;
        // Simplify: just return the text tree
        expression = `JSON.stringify((function walk(el, d) { if (!el || d > 5) return []; const r = []; for (const c of el.children || []) { const role = c.getAttribute("role") || c.tagName.toLowerCase(); const lbl = c.getAttribute("aria-label") || c.textContent?.trim()?.slice(0, 80) || ""; if (lbl) r.push({role, label: lbl}); r.push(...walk(c, d+1)); } return r; })(${scope}, 0).slice(0, 200))`;
        break;
      default:
        return { success: false, output: "", error: `Unknown extract mode: ${args.mode}` };
    }
    const value = await cdpEvaluate(chromeManager, expression);
    let data = value;
    if (
      typeof data === "string" &&
      (args.mode === "links" || args.mode === "forms" || args.mode === "tables" || args.mode === "accessibility")
    ) {
      try {
        data = JSON.parse(data);
      } catch {}
    }
    const output = typeof data === "string" ? data : JSON.stringify(data, null, 2);
    // Truncate at 50KB
    const truncated = output.length > 50000 ? output.slice(0, 50000) + "\n[TRUNCATED]" : output;
    return { success: true, output: truncated };
  } catch (e: any) {
    return { success: false, output: "", error: e.message };
  }
}

async function handleBrowserTabs(args: { action?: string; targetId?: string; url?: string }): Promise<ToolResult> {
  if (!chromeManager) return { success: false, output: "", error: "Browser not available" };
  try {
    const action = args.action || "list";
    const cdp = chromeManager.getCdp()!;
    switch (action) {
      case "list": {
        const { targetInfos } = await cdp.send("Target.getTargets");
        const pages = targetInfos
          .filter((t: any) => t.type === "page")
          .map((t: any) => ({
            id: t.targetId,
            url: t.url,
            title: t.title,
            attached: t.attached,
          }));
        return { success: true, output: JSON.stringify(pages, null, 2) };
      }
      case "new": {
        const { targetId } = await cdp.send("Target.createTarget", { url: args.url || "about:blank" });
        await chromeManager.switchToTarget(targetId);
        return { success: true, output: JSON.stringify({ created: true, targetId }, null, 2) };
      }
      case "close": {
        if (!args.targetId) return { success: false, output: "", error: "targetId required for close" };
        await cdp.send("Target.closeTarget", { targetId: args.targetId });
        return { success: true, output: JSON.stringify({ closed: true, targetId: args.targetId }, null, 2) };
      }
      case "switch": {
        if (!args.targetId) return { success: false, output: "", error: "targetId required for switch" };
        await chromeManager.switchToTarget(args.targetId);
        await cdp.send("Target.activateTarget", { targetId: args.targetId });
        return { success: true, output: JSON.stringify({ activated: true, targetId: args.targetId }, null, 2) };
      }
      default:
        return { success: false, output: "", error: `Unknown tab action: ${action}` };
    }
  } catch (e: any) {
    return { success: false, output: "", error: e.message };
  }
}

async function handleBrowserExecute(args: {
  code?: string;
  script_id?: string;
  script_args?: any;
}): Promise<ToolResult> {
  if (!chromeManager) return { success: false, output: "", error: "Browser not available" };
  try {
    let code = args.code || "";

    if (args.script_id) {
      const stored = scriptStore.get(args.script_id);
      if (!stored)
        return {
          success: false,
          output: "",
          error: `Script '${args.script_id}' not found. Use browser_store action=set first.`,
        };
      let argsJson: string;
      try {
        argsJson = JSON.stringify(args.script_args ?? {});
      } catch {
        return { success: false, output: "", error: "script_args is not JSON-serializable" };
      }
      code = "(async function(){const __args=" + argsJson + ";" + stored.code + "})()";
    }

    if (!code || code.trim() === "")
      return { success: false, output: "", error: "Either 'code' or 'script_id' is required" };

    // Only wrap inline code (script_id already wrapped above)
    if (!args.script_id) {
      code = "(async()=>{" + code + "})()";
    }

    const value = await cdpEvaluate(chromeManager, code);
    const output = typeof value === "string" ? value : JSON.stringify(value, null, 2);
    const truncated = output?.length > 50000 ? output.slice(0, 50000) + "\n[TRUNCATED]" : (output ?? "undefined");
    return { success: true, output: truncated };
  } catch (e: any) {
    return { success: false, output: "", error: e.message };
  }
}

async function handleBrowserStore(args: {
  action: string;
  key?: string;
  value?: string;
  description?: string;
}): Promise<ToolResult> {
  const action = args.action || "list";
  if (action === "set") {
    if (!args.key) return { success: false, output: "", error: "key is required" };
    if (!args.value) return { success: false, output: "", error: "value is required" };
    if (args.key.length > STORE_MAX_KEY_LEN)
      return { success: false, output: "", error: "key too long (max " + STORE_MAX_KEY_LEN + " chars)" };
    if (args.value.length > STORE_MAX_SCRIPT_SIZE)
      return { success: false, output: "", error: "script too large (max " + STORE_MAX_SCRIPT_SIZE + " bytes)" };
    if (!scriptStore.has(args.key) && scriptStore.size >= STORE_MAX_SCRIPTS)
      return { success: false, output: "", error: "store full (max " + STORE_MAX_SCRIPTS + " scripts)" };
    scriptStore.set(args.key, { code: args.value, description: args.description || "" });
    return { success: true, output: JSON.stringify({ stored: true, key: args.key }) };
  } else if (action === "get") {
    if (!args.key) return { success: false, output: "", error: "key is required" };
    const item = scriptStore.get(args.key);
    if (!item) return { success: true, output: JSON.stringify({ found: false }) };
    return {
      success: true,
      output: JSON.stringify({ found: true, key: args.key, value: item.code, description: item.description }),
    };
  } else if (action === "list") {
    const items: any[] = [];
    for (const [key, val] of scriptStore) {
      items.push({ key, description: val.description, size: val.code.length });
    }
    return { success: true, output: JSON.stringify({ count: items.length, items }) };
  } else if (action === "delete") {
    if (!args.key) return { success: false, output: "", error: "key is required" };
    const deleted = scriptStore.delete(args.key);
    return { success: true, output: JSON.stringify({ deleted }) };
  } else if (action === "clear") {
    const count = scriptStore.size;
    scriptStore.clear();
    return { success: true, output: JSON.stringify({ cleared: count }) };
  }
  return { success: false, output: "", error: "Unknown action: " + action };
}

async function handleBrowserAuth(args: { action: string; username?: string; password?: string }): Promise<ToolResult> {
  if (!chromeManager) return { success: false, output: "", error: "Browser not available" };
  try {
    const action = args.action || "status";
    if (action === "status") {
      const queue = chromeManager.getAuthQueue();
      if (queue.length === 0) return { success: true, output: JSON.stringify({ pending: false }) };
      const auth = queue[0];
      return {
        success: true,
        output: JSON.stringify({ pending: true, url: auth.url, scheme: auth.scheme, realm: auth.realm }),
      };
    } else if (action === "provide") {
      const auth = chromeManager.popAuth();
      if (!auth) return { success: false, output: "", error: "No pending auth challenge" };
      await chromeManager.pageSend("Fetch.continueWithAuth", {
        requestId: auth.requestId,
        authChallengeResponse: {
          response: "ProvideCredentials",
          username: args.username || "",
          password: args.password || "",
        },
      });
      return { success: true, output: JSON.stringify({ authenticated: true }) };
    } else if (action === "cancel") {
      const auth = chromeManager.popAuth();
      if (!auth) return { success: false, output: "", error: "No pending auth challenge" };
      await chromeManager.pageSend("Fetch.continueWithAuth", {
        requestId: auth.requestId,
        authChallengeResponse: { response: "CancelAuth" },
      });
      return { success: true, output: JSON.stringify({ cancelled: true }) };
    }
    return { success: false, output: "", error: "Unknown action: " + action };
  } catch (e: any) {
    return { success: false, output: "", error: e.message };
  }
}

async function handleBrowserPermissions(args: {
  action: string;
  permissions?: string[];
  origin?: string;
}): Promise<ToolResult> {
  if (!chromeManager) return { success: false, output: "", error: "Browser not available" };
  try {
    const action = args.action || "grant";
    const perms = args.permissions || [];
    if ((action === "grant" || action === "deny") && perms.length === 0) {
      return { success: false, output: "", error: "permissions array is required" };
    }
    // Map friendly names to CDP PermissionType
    const permMap: Record<string, string> = {
      camera: "videoCapture",
      microphone: "audioCapture",
      "clipboard-read": "clipboardReadWrite",
      "clipboard-write": "clipboardSanitizedWrite",
      "background-sync": "backgroundSync",
      "screen-wake-lock": "wakeLockScreen",
    };
    const cdpPerms = perms.map((p) => permMap[p] || p);
    if (action === "grant") {
      const params: Record<string, any> = { permissions: cdpPerms };
      if (args.origin) params.origin = args.origin;
      await chromeManager.getCdp()!.send("Browser.grantPermissions", params);
      return { success: true, output: JSON.stringify({ granted: cdpPerms }) };
    } else if (action === "deny") {
      // CDP has no "deny" — reset first then grant empty to effectively deny
      const params: Record<string, any> = {};
      if (args.origin) params.origin = args.origin;
      await chromeManager.getCdp()!.send("Browser.resetPermissions", params);
      return {
        success: true,
        output: JSON.stringify({ denied: cdpPerms, note: "Permissions reset (CDP has no explicit deny)" }),
      };
    } else if (action === "reset") {
      const params: Record<string, any> = {};
      if (args.origin) params.origin = args.origin;
      await chromeManager.getCdp()!.send("Browser.resetPermissions", params);
      return { success: true, output: JSON.stringify({ reset: true }) };
    }
    return { success: false, output: "", error: "Unknown action: " + action };
  } catch (e: any) {
    return { success: false, output: "", error: e.message };
  }
}

// ---------------------------------------------------------------------------
// 8c.1 Chat server file helpers
// ---------------------------------------------------------------------------

function getHttpBaseUrl(): string {
  return config.server.replace(/^ws(s?):\/\//, "http$1://");
}

async function downloadChatFile(fileId: string): Promise<string> {
  const url = `${getHttpBaseUrl()}/api/files/${encodeURIComponent(fileId)}`;
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`Failed to download file ${fileId}: ${resp.status}`);
  const buffer = Buffer.from(await resp.arrayBuffer());
  const disposition = resp.headers.get("content-disposition") || "";
  const match = disposition.match(/filename="?([^";\r\n]+)"?/);
  const name = match?.[1] || fileId;
  const { writeFileSync: writeTmp, mkdirSync: mkdirTmp } = await import("node:fs");
  const dir = join(REAL_TMP, "clawd-chat-files");
  mkdirTmp(dir, { recursive: true });
  let safeName = name.replace(/[/\\\0]/g, "_");
  if (!safeName || safeName === "." || safeName === "..") safeName = fileId;
  safeName = `${fileId.replace(/\//g, "_").slice(0, 32)}_${safeName}`;
  const path = join(dir, safeName);
  writeTmp(path, buffer);
  return path;
}

async function uploadChatFile(filePath: string): Promise<{ id: string; name: string }> {
  const data = readFileSync(filePath);
  const name = basename(filePath);
  const form = new FormData();
  form.append("file", new Blob([data]), name);
  const url = `${getHttpBaseUrl()}/api/files.upload`;
  const resp = await fetch(url, { method: "POST", body: form });
  if (!resp.ok) throw new Error(`Failed to upload file: ${resp.status}`);
  const result = (await resp.json()) as any;
  if (!result.ok) throw new Error(result.error || "Upload failed");
  return { id: result.file.id, name: result.file.name };
}

// ---------------------------------------------------------------------------
// 8d. Browser tool handlers — Tier 2
// ---------------------------------------------------------------------------

async function handleBrowserScroll(args: {
  direction?: string;
  amount?: number;
  selector?: string;
  x?: number;
  y?: number;
}): Promise<ToolResult> {
  if (!chromeManager) return { success: false, output: "", error: "Browser not available" };
  try {
    const direction = args.direction || "down";
    const amount = args.amount || 300;
    let cx = args.x ?? 0,
      cy = args.y ?? 0;
    if (args.selector) {
      const pos = await resolveSelector(chromeManager, args.selector);
      cx = pos.x;
      cy = pos.y;
    } else if (!args.x && !args.y) {
      // Default to center of viewport
      const metrics = await chromeManager.pageSend("Page.getLayoutMetrics");
      cx = (metrics.cssVisualViewport?.clientWidth || 800) / 2;
      cy = (metrics.cssVisualViewport?.clientHeight || 600) / 2;
    }
    const deltaX = direction === "left" ? -amount : direction === "right" ? amount : 0;
    const deltaY = direction === "up" ? -amount : direction === "down" ? amount : 0;
    await chromeManager.pageSend("Input.dispatchMouseEvent", { type: "mouseWheel", x: cx, y: cy, deltaX, deltaY });
    return { success: true, output: JSON.stringify({ scrolled: true, direction, amount }, null, 2) };
  } catch (e: any) {
    return { success: false, output: "", error: e.message };
  }
}

const KEY_MAP: Record<string, { key: string; code: string; keyCode?: number }> = {
  enter: { key: "Enter", code: "Enter", keyCode: 13 },
  tab: { key: "Tab", code: "Tab", keyCode: 9 },
  escape: { key: "Escape", code: "Escape", keyCode: 27 },
  backspace: { key: "Backspace", code: "Backspace", keyCode: 8 },
  delete: { key: "Delete", code: "Delete", keyCode: 46 },
  arrowup: { key: "ArrowUp", code: "ArrowUp", keyCode: 38 },
  arrowdown: { key: "ArrowDown", code: "ArrowDown", keyCode: 40 },
  arrowleft: { key: "ArrowLeft", code: "ArrowLeft", keyCode: 37 },
  arrowright: { key: "ArrowRight", code: "ArrowRight", keyCode: 39 },
  home: { key: "Home", code: "Home", keyCode: 36 },
  end: { key: "End", code: "End", keyCode: 35 },
  pageup: { key: "PageUp", code: "PageUp", keyCode: 33 },
  pagedown: { key: "PageDown", code: "PageDown", keyCode: 34 },
  space: { key: " ", code: "Space", keyCode: 32 },
  f1: { key: "F1", code: "F1", keyCode: 112 },
  f2: { key: "F2", code: "F2", keyCode: 113 },
  f5: { key: "F5", code: "F5", keyCode: 116 },
  f11: { key: "F11", code: "F11", keyCode: 122 },
  f12: { key: "F12", code: "F12", keyCode: 123 },
};

async function handleBrowserKeypress(args: { key: string; modifiers?: string[] }): Promise<ToolResult> {
  if (!chromeManager) return { success: false, output: "", error: "Browser not available" };
  if (!args.key) return { success: false, output: "", error: "key is required" };
  try {
    const mods = args.modifiers || [];
    let modifierFlags = 0;
    if (mods.includes("alt")) modifierFlags |= 1;
    if (mods.includes("ctrl") || mods.includes("control")) modifierFlags |= 2;
    if (mods.includes("meta") || mods.includes("cmd")) modifierFlags |= 4;
    if (mods.includes("shift")) modifierFlags |= 8;
    const mapped = KEY_MAP[args.key.toLowerCase()];
    const key = mapped?.key || args.key;
    const code = mapped?.code || (args.key.length === 1 ? `Key${args.key.toUpperCase()}` : args.key);
    await chromeManager.pageSend("Input.dispatchKeyEvent", {
      type: "keyDown",
      key,
      code,
      modifiers: modifierFlags,
      windowsVirtualKeyCode: mapped?.keyCode,
    });
    await chromeManager.pageSend("Input.dispatchKeyEvent", { type: "keyUp", key, code, modifiers: modifierFlags });
    return { success: true, output: JSON.stringify({ pressed: true, key: args.key, modifiers: mods }, null, 2) };
  } catch (e: any) {
    return { success: false, output: "", error: e.message };
  }
}

async function handleBrowserWaitFor(args: {
  selector: string;
  timeout?: number;
  visible?: boolean;
}): Promise<ToolResult> {
  if (!chromeManager) return { success: false, output: "", error: "Browser not available" };
  try {
    const timeout = args.timeout || 10000;
    const start = Date.now();
    const checkVisible = args.visible !== false;
    while (Date.now() - start < timeout) {
      const found = await cdpEvaluate(
        chromeManager,
        `(() => {
        const el = document.querySelector(${JSON.stringify(args.selector)});
        if (!el) return null;
        ${checkVisible ? `const r = el.getBoundingClientRect(); if (r.width === 0 && r.height === 0) return null;` : ""}
        return { tag: el.tagName, text: el.textContent?.trim()?.slice(0, 100) || "" };
      })()`,
      );
      if (found) {
        return {
          success: true,
          output: JSON.stringify({ found: true, element: found, elapsed_ms: Date.now() - start }, null, 2),
        };
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    return { success: false, output: "", error: `Element not found: ${args.selector} (timeout: ${timeout}ms)` };
  } catch (e: any) {
    return { success: false, output: "", error: e.message };
  }
}

async function handleBrowserSelect(args: {
  selector: string;
  value?: string;
  text?: string;
  index?: number;
}): Promise<ToolResult> {
  if (!chromeManager) return { success: false, output: "", error: "Browser not available" };
  try {
    const sel = JSON.stringify(args.selector);
    let expression: string;
    if (args.value !== undefined) {
      expression = `(() => { const el = document.querySelector(${sel}); if (!el) throw new Error("Not found"); el.value = ${JSON.stringify(args.value)}; el.dispatchEvent(new Event("change", {bubbles:true})); return {selected: true, value: el.value}; })()`;
    } else if (args.text !== undefined) {
      expression = `(() => { const el = document.querySelector(${sel}); if (!el) throw new Error("Not found"); const opt = Array.from(el.options).find(o => o.text === ${JSON.stringify(args.text)}); if (!opt) throw new Error("Option not found"); el.value = opt.value; el.dispatchEvent(new Event("change", {bubbles:true})); return {selected: true, value: opt.value, text: opt.text}; })()`;
    } else if (args.index !== undefined) {
      expression = `(() => { const el = document.querySelector(${sel}); if (!el) throw new Error("Not found"); el.selectedIndex = ${args.index}; el.dispatchEvent(new Event("change", {bubbles:true})); return {selected: true, index: el.selectedIndex, value: el.value}; })()`;
    } else {
      return { success: false, output: "", error: "Provide value, text, or index" };
    }
    const result = await cdpEvaluate(chromeManager, expression);
    return { success: true, output: JSON.stringify(result, null, 2) };
  } catch (e: any) {
    return { success: false, output: "", error: e.message };
  }
}

async function handleBrowserHover(args: { selector?: string; x?: number; y?: number }): Promise<ToolResult> {
  if (!chromeManager) return { success: false, output: "", error: "Browser not available" };
  try {
    let cx: number, cy: number;
    if (args.selector) {
      const pos = await resolveSelector(chromeManager, args.selector);
      cx = pos.x;
      cy = pos.y;
    } else if (args.x !== undefined && args.y !== undefined) {
      cx = args.x;
      cy = args.y;
    } else {
      return { success: false, output: "", error: "Provide selector or x,y coordinates" };
    }
    await chromeManager.pageSend("Input.dispatchMouseEvent", { type: "mouseMoved", x: cx, y: cy });
    return { success: true, output: JSON.stringify({ hovered: true, x: cx, y: cy }, null, 2) };
  } catch (e: any) {
    return { success: false, output: "", error: e.message };
  }
}

async function handleBrowserHistory(args: { action: string }): Promise<ToolResult> {
  if (!chromeManager) return { success: false, output: "", error: "Browser not available" };
  try {
    const { currentIndex, entries } = await chromeManager.pageSend("Page.getNavigationHistory");
    if (args.action === "back") {
      if (currentIndex <= 0) return { success: false, output: "", error: "No history to go back" };
      await chromeManager.pageSend("Page.navigateToHistoryEntry", { entryId: entries[currentIndex - 1].id });
    } else if (args.action === "forward") {
      if (currentIndex >= entries.length - 1) return { success: false, output: "", error: "No history to go forward" };
      await chromeManager.pageSend("Page.navigateToHistoryEntry", { entryId: entries[currentIndex + 1].id });
    } else {
      return { success: false, output: "", error: `Unknown action: ${args.action}` };
    }
    await new Promise((r) => setTimeout(r, 1000)); // Wait for navigation
    const url = await cdpEvaluate(chromeManager, "window.location.href");
    const title = await cdpEvaluate(chromeManager, "document.title");
    return { success: true, output: JSON.stringify({ navigated: true, action: args.action, url, title }, null, 2) };
  } catch (e: any) {
    return { success: false, output: "", error: e.message };
  }
}

async function handleBrowserDialog(args: { action?: string; prompt_text?: string }): Promise<ToolResult> {
  if (!chromeManager) return { success: false, output: "", error: "Browser not available" };
  try {
    const dialogs = chromeManager.getPendingDialogs();
    if (dialogs.length === 0) {
      return { success: true, output: JSON.stringify({ handled: false, message: "No pending dialog" }, null, 2) };
    }
    const dialog = dialogs.shift()!;
    const accept = args.action !== "dismiss";
    await chromeManager.pageSend("Page.handleJavaScriptDialog", {
      accept,
      promptText: args.prompt_text || dialog.defaultPrompt || "",
    });
    return {
      success: true,
      output: JSON.stringify(
        { handled: true, type: dialog.type, message: dialog.message, action: accept ? "accepted" : "dismissed" },
        null,
        2,
      ),
    };
  } catch (e: any) {
    return { success: false, output: "", error: e.message };
  }
}

async function handleBrowserUpload(args: any): Promise<ToolResult> {
  if (!chromeManager) return { success: false, output: "", error: "Browser not available" };
  const { existsSync: existsSyncUp, unlinkSync: unlinkTmp } = await import("node:fs");
  const tempFiles: string[] = [];
  try {
    const selector = args.selector as string;
    const files = args.files as string[] | undefined;
    if (!selector) return { success: false, output: "", error: "selector is required" };
    // Verify local files exist
    if (files && Array.isArray(files)) {
      for (const f of files) {
        if (!existsSyncUp(f)) return { success: false, output: "", error: `File not found: ${f}` };
      }
    }
    // Download chat files if file_ids provided
    const fileIds = args.file_ids as string[] | undefined;
    if (fileIds && Array.isArray(fileIds)) {
      for (const fid of fileIds) {
        const tempPath = await downloadChatFile(fid);
        tempFiles.push(tempPath);
      }
    }
    const allFiles = [...(files || []), ...tempFiles];
    if (allFiles.length === 0) return { success: false, output: "", error: "files or file_ids required" };
    // Resolve selector to get nodeId
    const { nodeId } = await resolveSelector(chromeManager, selector);
    // Set files on the input element
    await chromeManager.pageSend("DOM.setFileInputFiles", { files: allFiles, nodeId });
    // Dispatch change and input events so page JS handlers fire
    await cdpEvaluate(
      chromeManager,
      `(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (el) {
        el.dispatchEvent(new Event('change', { bubbles: true }));
        el.dispatchEvent(new Event('input', { bubbles: true }));
      }
    })()`,
    );
    // Clean up temp files
    for (const f of tempFiles) {
      try {
        unlinkTmp(f);
      } catch {}
    }
    return { success: true, output: `Uploaded ${allFiles.length} file(s) to ${selector}` };
  } catch (e: any) {
    for (const f of tempFiles) {
      try {
        unlinkTmp(f);
      } catch {}
    }
    return { success: false, output: "", error: e.message };
  }
}

async function handleBrowserDownload(args: any): Promise<ToolResult> {
  if (!chromeManager) return { success: false, output: "", error: "Browser not available" };
  try {
    const action = (args.action as string) || "list";
    if (action === "configure") {
      const path = args.path as string;
      if (!path) return { success: false, output: "", error: "path is required for configure" };
      const resolvedPath = pathResolve(path);
      const home = process.env.HOME || process.env.USERPROFILE || "";
      const tmpDir = process.env.TMPDIR || REAL_TMP;
      if (!resolvedPath.startsWith(home) && !resolvedPath.startsWith(tmpDir)) {
        return { success: false, output: "", error: "Download path must be under $HOME or $TMPDIR" };
      }
      const { mkdirSync: mkdirSyncCfg } = await import("node:fs");
      mkdirSyncCfg(resolvedPath, { recursive: true });
      chromeManager.setDownloadPath(resolvedPath);
      await chromeManager.getCdp()!.send("Browser.setDownloadBehavior", {
        behavior: "allowAndName",
        downloadPath: resolvedPath,
        eventsEnabled: true,
      });
      return { success: true, output: `Download directory set to ${resolvedPath}` };
    } else if (action === "wait") {
      const timeout = (args.timeout as number) || 30000;
      const deadline = Date.now() + timeout;
      const allDl = chromeManager.getDownloads();
      const startCount = allDl.filter((d) => d.state === "completed").length;
      const startCanceledCount = allDl.filter((d) => d.state === "canceled").length;
      while (Date.now() < deadline) {
        const currentDl = chromeManager.getDownloads();
        const completed = currentDl.filter((d) => d.state === "completed");
        if (completed.length > startCount) {
          const latest = completed[completed.length - 1];
          let fileInfo: { id: string; name: string } | undefined;
          if (args.upload && latest.path) {
            try {
              const { existsSync: existsSyncChk } = await import("node:fs");
              if (existsSyncChk(latest.path)) {
                fileInfo = await uploadChatFile(latest.path);
              }
            } catch {
              // Upload failed but download succeeded — still return download info
            }
          }
          return {
            success: true,
            output: JSON.stringify(
              {
                filename: latest.filename,
                path: latest.path,
                url: latest.url,
                totalBytes: latest.totalBytes,
                ...(fileInfo ? { file_id: fileInfo.id, file_name: fileInfo.name } : {}),
              },
              null,
              2,
            ),
          };
        }
        // Only check new cancellations
        const canceledNow = currentDl.filter((d) => d.state === "canceled");
        if (canceledNow.length > startCanceledCount) {
          const latest = canceledNow[canceledNow.length - 1];
          return { success: false, output: "", error: `Download canceled: ${latest.filename}` };
        }
        await new Promise((r) => setTimeout(r, 500));
      }
      return { success: false, output: "", error: `No download completed within ${timeout}ms` };
    } else if (action === "list") {
      const downloads = chromeManager.getDownloads().map((d) => ({
        filename: d.filename,
        url: d.url,
        state: d.state,
        totalBytes: d.totalBytes,
        receivedBytes: d.receivedBytes,
        path: d.path,
      }));
      return { success: true, output: JSON.stringify(downloads, null, 2) };
    } else {
      return { success: false, output: "", error: `Unknown action: ${action}. Use "configure", "wait", or "list"` };
    }
  } catch (e: any) {
    return { success: false, output: "", error: e.message };
  }
}

async function handleBrowserMouseMove(args: any): Promise<ToolResult> {
  if (!chromeManager) return { success: false, output: "", error: "Browser not available" };
  try {
    const x = args.x as number;
    const y = args.y as number;
    if (x === undefined || y === undefined) return { success: false, output: "", error: "x and y required" };
    const steps = (args.steps as number) || 1;
    // Get current position or start from 0,0
    const startX = args.from_x ?? 0;
    const startY = args.from_y ?? 0;
    for (let i = 1; i <= steps; i++) {
      const px = startX + (x - startX) * (i / steps);
      const py = startY + (y - startY) * (i / steps);
      await chromeManager.pageSend("Input.dispatchMouseEvent", { type: "mouseMoved", x: px, y: py });
    }
    return { success: true, output: `Moved mouse to (${x}, ${y})` };
  } catch (e: any) {
    return { success: false, output: "", error: e.message };
  }
}

async function handleBrowserDrag(args: any): Promise<ToolResult> {
  if (!chromeManager) return { success: false, output: "", error: "Browser not available" };
  try {
    let fromX: number, fromY: number, toX: number, toY: number;
    if (args.from_selector) {
      const pos = await resolveSelector(chromeManager, args.from_selector);
      fromX = pos.x;
      fromY = pos.y;
    } else if (args.from_x !== undefined && args.from_y !== undefined) {
      fromX = args.from_x;
      fromY = args.from_y;
    } else {
      return { success: false, output: "", error: "from_selector or from_x/from_y required" };
    }
    if (args.to_selector) {
      const pos = await resolveSelector(chromeManager, args.to_selector);
      toX = pos.x;
      toY = pos.y;
    } else if (args.to_x !== undefined && args.to_y !== undefined) {
      toX = args.to_x;
      toY = args.to_y;
    } else {
      return { success: false, output: "", error: "to_selector or to_x/to_y required" };
    }
    const steps = (args.steps as number) || 10;
    // Press at start
    await chromeManager.pageSend("Input.dispatchMouseEvent", {
      type: "mousePressed",
      x: fromX,
      y: fromY,
      button: "left",
      clickCount: 1,
    });
    // Move in steps
    for (let i = 1; i <= steps; i++) {
      const px = fromX + (toX - fromX) * (i / steps);
      const py = fromY + (toY - fromY) * (i / steps);
      await chromeManager.pageSend("Input.dispatchMouseEvent", { type: "mouseMoved", x: px, y: py, button: "left" });
      await new Promise((r) => setTimeout(r, 20));
    }
    // Release at end
    await chromeManager.pageSend("Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x: toX,
      y: toY,
      button: "left",
      clickCount: 1,
    });
    return {
      success: true,
      output: `Dragged from (${fromX.toFixed(0)}, ${fromY.toFixed(0)}) to (${toX.toFixed(0)}, ${toY.toFixed(0)})`,
    };
  } catch (e: any) {
    return { success: false, output: "", error: e.message };
  }
}

async function handleBrowserTouch(args: any): Promise<ToolResult> {
  if (!chromeManager) return { success: false, output: "", error: "Browser not available" };
  try {
    const action = args.action || "tap";
    let x: number, y: number;
    if (args.selector) {
      const pos = await resolveSelector(chromeManager, args.selector);
      x = pos.x;
      y = pos.y;
    } else if (args.x !== undefined && args.y !== undefined) {
      x = args.x;
      y = args.y;
    } else {
      return { success: false, output: "", error: "selector or x,y required" };
    }

    const touchPoint = (px: number, py: number, id = 0) => ({ x: px, y: py, id, radiusX: 1, radiusY: 1, force: 1 });

    if (action === "tap") {
      await chromeManager.pageSend("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [touchPoint(x, y)] });
      await new Promise((r) => setTimeout(r, 50));
      await chromeManager.pageSend("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    } else if (action === "swipe") {
      const endX = args.end_x ?? x;
      const endY = args.end_y ?? y;
      const steps = 10;
      await chromeManager.pageSend("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [touchPoint(x, y)] });
      for (let i = 1; i <= steps; i++) {
        const px = x + (endX - x) * (i / steps);
        const py = y + (endY - y) * (i / steps);
        await chromeManager.pageSend("Input.dispatchTouchEvent", {
          type: "touchMove",
          touchPoints: [touchPoint(px, py)],
        });
        await new Promise((r) => setTimeout(r, 20));
      }
      await chromeManager.pageSend("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    } else if (action === "long-press") {
      const duration = args.duration || 500;
      await chromeManager.pageSend("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [touchPoint(x, y)] });
      await new Promise((r) => setTimeout(r, duration));
      await chromeManager.pageSend("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    } else if (action === "pinch") {
      const scale = args.scale || 1.5;
      const steps = 10;
      const halfGap = 50;
      await chromeManager.pageSend("Input.dispatchTouchEvent", {
        type: "touchStart",
        touchPoints: [touchPoint(x - halfGap, y, 0), touchPoint(x + halfGap, y, 1)],
      });
      for (let i = 1; i <= steps; i++) {
        const currentHalf = halfGap * (1 + (scale - 1) * (i / steps));
        await chromeManager.pageSend("Input.dispatchTouchEvent", {
          type: "touchMove",
          touchPoints: [touchPoint(x - currentHalf, y, 0), touchPoint(x + currentHalf, y, 1)],
        });
        await new Promise((r) => setTimeout(r, 20));
      }
      await chromeManager.pageSend("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    } else {
      return { success: false, output: "", error: `Unknown touch action: ${action}` };
    }
    return { success: true, output: `Touch ${action} at (${x.toFixed(0)}, ${y.toFixed(0)})` };
  } catch (e: any) {
    return { success: false, output: "", error: e.message };
  }
}

async function handleBrowserFrames(): Promise<ToolResult> {
  if (!chromeManager) return { success: false, output: "", error: "Browser not available" };
  try {
    const { frameTree } = await chromeManager.pageSend("Page.getFrameTree");
    function flattenFrames(node: any): any[] {
      const frames = [
        {
          id: node.frame.id,
          url: node.frame.url,
          name: node.frame.name || "",
          securityOrigin: node.frame.securityOrigin,
        },
      ];
      for (const child of node.childFrames || []) frames.push(...flattenFrames(child));
      return frames;
    }
    return { success: true, output: JSON.stringify(flattenFrames(frameTree), null, 2) };
  } catch (e: any) {
    return { success: false, output: "", error: e.message };
  }
}

// ---------------------------------------------------------------------------
// 8b. Git tools — thin wrappers over shell commands, cross-platform
// ---------------------------------------------------------------------------

async function runGitCommand(gitArgs: string, cwd?: string): Promise<ToolResult> {
  const workDir = cwd || config.projectRoot || process.cwd();
  const shell = resolveShell(`git ${gitArgs}`);
  return new Promise((resolve) => {
    const proc = spawn(shell.exe, shell.args, {
      cwd: workDir,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
      timeout: 30_000,
    } as SpawnOptions);
    let stdout = "";
    let stderr = "";
    proc.stdout?.on("data", (d: Buffer) => { stdout += d.toString(); });
    proc.stderr?.on("data", (d: Buffer) => { stderr += d.toString(); });
    proc.on("close", (code) => {
      const output = (stdout + (stderr ? `\n${stderr}` : "")).trim();
      resolve({ success: code === 0, output: output.slice(0, 64_000), error: code !== 0 ? stderr.trim() : undefined });
    });
    proc.on("error", (e) => resolve({ success: false, output: "", error: e.message }));
  });
}

async function handleGitTool(tool: string, args: any): Promise<ToolResult> {
  const cwd = args.cwd as string | undefined;
  const extra = (args.args as string) || "";
  switch (tool) {
    case "git_status":
      return runGitCommand(`status ${extra}`.trim(), cwd);
    case "git_diff":
      return runGitCommand(`diff ${args.staged ? "--cached " : ""}${extra}`.trim(), cwd);
    case "git_log":
      return runGitCommand(`log ${extra || "--oneline -20"}`.trim(), cwd);
    case "git_branch":
      return runGitCommand(`branch ${extra}`.trim(), cwd);
    case "git_checkout":
      return runGitCommand(`checkout ${args.target || ""} ${extra}`.trim(), cwd);
    case "git_add":
      return runGitCommand(`add ${args.files || "."}`, cwd);
    case "git_commit": {
      if (!args.message) return { success: false, output: "", error: "Missing required parameter: message" };
      // Use -m with properly escaped message
      const msg = (args.message as string).replace(/"/g, '\\"');
      return runGitCommand(`commit -m "${msg}" ${extra}`.trim(), cwd);
    }
    case "git_push":
      return runGitCommand(`push ${extra}`.trim(), cwd);
    case "git_pull":
      return runGitCommand(`pull ${extra}`.trim(), cwd);
    case "git_fetch":
      return runGitCommand(`fetch ${extra}`.trim(), cwd);
    case "git_stash":
      return runGitCommand(`stash ${args.action || ""} ${extra}`.trim(), cwd);
    case "git_reset":
      return runGitCommand(`reset ${extra}`.trim(), cwd);
    case "git_show":
      return runGitCommand(`show ${extra || "HEAD"}`.trim(), cwd);
    default:
      return { success: false, output: "", error: `Unknown git tool: ${tool}` };
  }
}

async function handleBrowserTool(tool: string, args: any): Promise<ToolResult> {
  switch (tool) {
    case "browser_status":
      return handleBrowserStatus();
    case "browser_navigate":
      return handleBrowserNavigate(args);
    case "browser_screenshot":
      return handleBrowserScreenshot(args);
    case "browser_click":
      return handleBrowserClick(args);
    case "browser_type":
      return handleBrowserType(args);
    case "browser_extract":
      return handleBrowserExtract(args);
    case "browser_tabs":
      return handleBrowserTabs(args);
    case "browser_execute":
      return handleBrowserExecute(args);
    case "browser_scroll":
      return handleBrowserScroll(args);
    case "browser_keypress":
      return handleBrowserKeypress(args);
    case "browser_wait_for":
      return handleBrowserWaitFor(args);
    case "browser_select":
      return handleBrowserSelect(args);
    case "browser_hover":
      return handleBrowserHover(args);
    case "browser_history":
      return handleBrowserHistory(args);
    case "browser_handle_dialog":
      return handleBrowserDialog(args);
    case "browser_auth":
      return handleBrowserAuth(args);
    case "browser_permissions":
      return handleBrowserPermissions(args);
    case "browser_store":
      return handleBrowserStore(args);
    case "browser_frames":
      return handleBrowserFrames();
    case "browser_mouse_move":
      return handleBrowserMouseMove(args);
    case "browser_drag":
      return handleBrowserDrag(args);
    case "browser_touch":
      return handleBrowserTouch(args);
    case "browser_upload":
      return handleBrowserUpload(args);
    case "browser_download":
      return handleBrowserDownload(args);
    default:
      return { success: false, output: "", error: `Unknown browser tool: ${tool}` };
  }
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
    name: "get_environment",
    description: "Get remote machine environment: OS, platform, shell, project root, and runtime info.",
    inputSchema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "today",
    description: "Get current date and time on the remote machine.",
    inputSchema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "git_status",
    description: "Run git status in the project directory.",
    inputSchema: { type: "object", properties: { cwd: { type: "string", description: "Working directory" } }, required: [] },
  },
  {
    name: "git_diff",
    description: "Run git diff. Use staged=true for staged changes.",
    inputSchema: { type: "object", properties: { args: { type: "string", description: "Additional git diff arguments" }, staged: { type: "boolean" }, cwd: { type: "string" } }, required: [] },
  },
  {
    name: "git_log",
    description: "Show git commit history.",
    inputSchema: { type: "object", properties: { args: { type: "string", description: "Additional git log arguments (e.g. '-5 --oneline')" }, cwd: { type: "string" } }, required: [] },
  },
  {
    name: "git_branch",
    description: "List, create, or delete branches.",
    inputSchema: { type: "object", properties: { args: { type: "string", description: "Branch arguments (e.g. '-a', 'new-branch', '-d old-branch')" }, cwd: { type: "string" } }, required: [] },
  },
  {
    name: "git_checkout",
    description: "Switch branches or restore files.",
    inputSchema: { type: "object", properties: { target: { type: "string", description: "Branch name or file path" }, args: { type: "string" }, cwd: { type: "string" } }, required: ["target"] },
  },
  {
    name: "git_add",
    description: "Stage files for commit.",
    inputSchema: { type: "object", properties: { files: { type: "string", description: "Files to stage (space-separated, or '.' for all)" }, cwd: { type: "string" } }, required: ["files"] },
  },
  {
    name: "git_commit",
    description: "Create a git commit.",
    inputSchema: { type: "object", properties: { message: { type: "string", description: "Commit message" }, args: { type: "string" }, cwd: { type: "string" } }, required: ["message"] },
  },
  {
    name: "git_push",
    description: "Push commits to remote.",
    inputSchema: { type: "object", properties: { args: { type: "string", description: "Push arguments (e.g. 'origin main', '-u origin feature')" }, cwd: { type: "string" } }, required: [] },
  },
  {
    name: "git_pull",
    description: "Pull changes from remote.",
    inputSchema: { type: "object", properties: { args: { type: "string", description: "Pull arguments (e.g. 'origin main', '--rebase')" }, cwd: { type: "string" } }, required: [] },
  },
  {
    name: "git_fetch",
    description: "Fetch from remote without merging.",
    inputSchema: { type: "object", properties: { args: { type: "string" }, cwd: { type: "string" } }, required: [] },
  },
  {
    name: "git_stash",
    description: "Stash or restore uncommitted changes.",
    inputSchema: { type: "object", properties: { action: { type: "string", description: "'push', 'pop', 'list', 'drop'" }, args: { type: "string" }, cwd: { type: "string" } }, required: [] },
  },
  {
    name: "git_reset",
    description: "Reset HEAD to a specific state.",
    inputSchema: { type: "object", properties: { args: { type: "string", description: "Reset arguments (e.g. '--soft HEAD~1', '--hard')" }, cwd: { type: "string" } }, required: [] },
  },
  {
    name: "git_show",
    description: "Show commit details or file contents at a revision.",
    inputSchema: { type: "object", properties: { args: { type: "string", description: "Show arguments (e.g. 'HEAD', 'HEAD:path/to/file')" }, cwd: { type: "string" } }, required: [] },
  },
  {
    name: "bash",
    description: "Run a shell command. Uses bash on Linux/macOS, PowerShell/cmd on Windows. Use OS-native syntax.",
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

const BROWSER_TOOL_SCHEMAS: ToolSchema[] = [
  {
    name: "browser_status",
    description: "Check if the browser is running and connected via CDP",
    inputSchema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "browser_navigate",
    description: "Navigate to a URL in the browser",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "URL to navigate to" },
        tab_id: { type: "string", description: "Target tab ID (optional, uses active tab)" },
      },
      required: ["url"],
    },
  },
  {
    name: "browser_screenshot",
    description: "Take a screenshot of the current browser tab. Returns base64 JPEG.",
    inputSchema: {
      type: "object",
      properties: {
        selector: { type: "string", description: "CSS selector to screenshot a specific element" },
        full_page: { type: "boolean", description: "Capture full scrollable page (default: false)" },
        quality: { type: "number", description: "JPEG quality 0-100 (default: 80)" },
      },
      required: [],
    },
  },
  {
    name: "browser_click",
    description: "Click an element on the page by CSS selector or coordinates",
    inputSchema: {
      type: "object",
      properties: {
        selector: { type: "string", description: "CSS selector of element to click" },
        x: { type: "number", description: "X coordinate (if no selector)" },
        y: { type: "number", description: "Y coordinate (if no selector)" },
        button: { type: "string", enum: ["left", "right", "middle"], description: "Mouse button (default: left)" },
        double: { type: "boolean", description: "Double-click (default: false)" },
      },
      required: [],
    },
  },
  {
    name: "browser_type",
    description: "Type text into an input element",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string", description: "Text to type" },
        selector: {
          type: "string",
          description: "CSS selector of input element (optional, types into focused element)",
        },
        clear: { type: "boolean", description: "Clear the field before typing (default: false)" },
        submit: { type: "boolean", description: "Press Enter after typing (default: false)" },
      },
      required: ["text"],
    },
  },
  {
    name: "browser_extract",
    description: "Extract structured content from the page",
    inputSchema: {
      type: "object",
      properties: {
        mode: {
          type: "string",
          enum: ["text", "links", "forms", "tables", "html", "accessibility"],
          description: "Extraction mode",
        },
        selector: { type: "string", description: "CSS selector to scope extraction" },
      },
      required: ["mode"],
    },
  },
  {
    name: "browser_tabs",
    description: "List, create, close, or switch browser tabs",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["list", "new", "close", "switch"], description: "Tab action (default: list)" },
        targetId: { type: "string", description: "Target tab ID (for close/switch)" },
        url: { type: "string", description: "URL for new tab (for create)" },
      },
      required: [],
    },
  },
  {
    name: "browser_execute",
    description: "Execute JavaScript code in the browser page context",
    inputSchema: {
      type: "object",
      properties: {
        code: { type: "string", description: "JavaScript code to execute" },
        script_id: { type: "string", description: "Key of a stored script (saved via browser_store)" },
        script_args: { type: "object", description: "Arguments passed to stored script as __args variable" },
      },
      required: [],
    },
  },
  // Tier 2 tools
  {
    name: "browser_scroll",
    description: "Scroll the page or an element in a direction",
    inputSchema: {
      type: "object",
      properties: {
        direction: {
          type: "string",
          enum: ["up", "down", "left", "right"],
          description: "Scroll direction (default: down)",
        },
        amount: { type: "number", description: "Scroll amount in pixels (default: 300)" },
        selector: { type: "string", description: "CSS selector of element to scroll within" },
        x: { type: "number", description: "X coordinate for scroll position" },
        y: { type: "number", description: "Y coordinate for scroll position" },
      },
      required: [],
    },
  },
  {
    name: "browser_keypress",
    description: "Press a keyboard key with optional modifiers (ctrl, shift, alt, meta)",
    inputSchema: {
      type: "object",
      properties: {
        key: { type: "string", description: "Key to press (e.g. Enter, Tab, ArrowDown, a, F5)" },
        modifiers: { type: "array", items: { type: "string" }, description: "Modifier keys: ctrl, shift, alt, meta" },
      },
      required: ["key"],
    },
  },
  {
    name: "browser_wait_for",
    description: "Wait for an element to appear on the page",
    inputSchema: {
      type: "object",
      properties: {
        selector: { type: "string", description: "CSS selector to wait for" },
        timeout: { type: "number", description: "Max wait time in ms (default: 10000)" },
        visible: { type: "boolean", description: "Require element to be visible (default: true)" },
      },
      required: ["selector"],
    },
  },
  {
    name: "browser_select",
    description: "Select an option in a dropdown/select element",
    inputSchema: {
      type: "object",
      properties: {
        selector: { type: "string", description: "CSS selector of the select element" },
        value: { type: "string", description: "Option value to select" },
        text: { type: "string", description: "Option text to select" },
        index: { type: "number", description: "Option index to select" },
      },
      required: ["selector"],
    },
  },
  {
    name: "browser_hover",
    description: "Hover over an element on the page",
    inputSchema: {
      type: "object",
      properties: {
        selector: { type: "string", description: "CSS selector of element to hover" },
        x: { type: "number", description: "X coordinate" },
        y: { type: "number", description: "Y coordinate" },
      },
      required: [],
    },
  },
  {
    name: "browser_history",
    description: "Navigate browser history (back or forward)",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["back", "forward"], description: "Navigation direction" },
      },
      required: ["action"],
    },
  },
  {
    name: "browser_store",
    description:
      "Store and retrieve reusable scripts. Save scripts with action=set, run them via browser_execute with script_id.",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["set", "get", "list", "delete", "clear"], description: "Storage action" },
        key: { type: "string", description: "Script key/ID (required for set/get/delete)" },
        value: { type: "string", description: "Script code to store (required for set)" },
        description: { type: "string", description: "Human-readable description of the script" },
      },
      required: ["action"],
    },
  },
  {
    name: "browser_handle_dialog",
    description: "Handle a JavaScript dialog (alert, confirm, prompt)",
    inputSchema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["accept", "dismiss"],
          description: "Accept or dismiss the dialog (default: accept)",
        },
        prompt_text: { type: "string", description: "Text to enter in a prompt dialog" },
      },
      required: [],
    },
  },
  {
    name: "browser_auth",
    description: "Handle HTTP Basic/Digest authentication",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["status", "provide", "cancel"], description: "Auth action" },
        username: { type: "string", description: "Username for authentication" },
        password: { type: "string", description: "Password for authentication" },
      },
      required: ["action"],
    },
  },
  {
    name: "browser_permissions",
    description:
      "Grant, deny, or reset browser permissions for a site (camera, microphone, geolocation, notifications, clipboard, etc.)",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["grant", "deny", "reset"], description: "Permission action" },
        permissions: {
          type: "array",
          items: { type: "string" },
          description:
            'Permission names: "geolocation", "camera", "microphone", "notifications", "clipboard-read", "clipboard-write", "midi", "background-sync", "sensors", "screen-wake-lock"',
        },
        origin: { type: "string", description: "Origin to apply permissions to (default: all origins)" },
      },
      required: ["action"],
    },
  },
  {
    name: "browser_frames",
    description: "List all frames (iframes) in the current page",
    inputSchema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "browser_mouse_move",
    description: "Move the mouse cursor to a specific position",
    inputSchema: {
      type: "object",
      properties: {
        x: { type: "number", description: "Target X coordinate" },
        y: { type: "number", description: "Target Y coordinate" },
        steps: { type: "number", description: "Number of intermediate steps (default: 1)" },
        from_x: { type: "number", description: "Start X coordinate" },
        from_y: { type: "number", description: "Start Y coordinate" },
      },
      required: ["x", "y"],
    },
  },
  {
    name: "browser_drag",
    description: "Drag from one element/position to another (drag-and-drop)",
    inputSchema: {
      type: "object",
      properties: {
        from_selector: { type: "string", description: "CSS selector of element to drag from" },
        from_x: { type: "number", description: "Start X coordinate" },
        from_y: { type: "number", description: "Start Y coordinate" },
        to_selector: { type: "string", description: "CSS selector of drop target" },
        to_x: { type: "number", description: "End X coordinate" },
        to_y: { type: "number", description: "End Y coordinate" },
        steps: { type: "number", description: "Number of intermediate move steps (default: 10)" },
      },
      required: [],
    },
  },
  {
    name: "browser_touch",
    description: "Perform touch gestures (tap, swipe, long-press, pinch)",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["tap", "swipe", "long-press", "pinch"], description: "Touch action type" },
        selector: { type: "string", description: "CSS selector of target element" },
        x: { type: "number", description: "Start X coordinate" },
        y: { type: "number", description: "Start Y coordinate" },
        end_x: { type: "number", description: "End X for swipe" },
        end_y: { type: "number", description: "End Y for swipe" },
        scale: { type: "number", description: "Scale factor for pinch (0.5=zoom out, 2.0=zoom in)" },
        duration: { type: "number", description: "Hold duration in ms for long-press (default: 500)" },
      },
      required: [],
    },
  },
  {
    name: "browser_upload",
    description: "Upload files to a file input element on the page",
    inputSchema: {
      type: "object",
      properties: {
        selector: { type: "string", description: "CSS selector of the <input type='file'> element" },
        files: {
          type: "array",
          items: { type: "string" },
          description: "Array of absolute file paths on the local machine",
        },
        file_ids: {
          type: "array",
          items: { type: "string" },
          description: "Array of chat file IDs to download from server and upload to the browser",
        },
      },
      required: ["selector"],
    },
  },
  {
    name: "browser_download",
    description: "Manage file downloads: configure download directory, wait for downloads, or list tracked downloads",
    inputSchema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["configure", "wait", "list"],
          description: "Action: configure download path, wait for next download, or list downloads",
        },
        path: { type: "string", description: "Download directory path (for 'configure' action)" },
        timeout: { type: "number", description: "Max wait time in milliseconds (for 'wait' action, default: 30000)" },
        upload: {
          type: "boolean",
          description: "Upload completed download to chat server and return file_id (for 'wait' action)",
        },
      },
      required: [],
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
      tools: config.browser ? [...TOOL_SCHEMAS, ...BROWSER_TOOL_SCHEMAS] : TOOL_SCHEMAS,
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
      case "get_environment":
      case "get_system_info": {
        const os = await import("node:os");
        const shell = resolveShell("echo test");
        result = {
          success: true,
          output: JSON.stringify(
            {
              project_root: config.projectRoot || process.cwd(),
              os: process.platform,
              os_version: os.release(),
              arch: os.arch(),
              hostname: os.hostname(),
              shell: shell.exe,
              shell_type: IS_WINDOWS
                ? shell.exe.toLowerCase().includes("powershell") || shell.exe.toLowerCase().includes("pwsh")
                  ? "powershell"
                  : "cmd"
                : "bash",
              home: os.homedir(),
              user: os.userInfo().username,
              runtime: typeof Bun !== "undefined" ? `Bun ${Bun.version}` : `Node ${process.version}`,
              cpus: os.cpus().length,
              memory_gb: Math.round(os.totalmem() / 1024 / 1024 / 1024),
              is_remote: true,
              worker_name: config.name,
              hint: IS_WINDOWS
                ? "This is a Windows remote machine. Use native PowerShell/cmd commands."
                : "This is a Unix remote machine. Use bash/shell commands.",
            },
            null,
            2,
          ),
        };
        break;
      }
      case "today": {
        const now = new Date();
        result = {
          success: true,
          output: JSON.stringify({
            iso: now.toISOString(),
            date: now.toLocaleDateString("en-CA"),
            time: now.toLocaleTimeString("en-US", { hour12: false }),
            day: now.toLocaleDateString("en-US", { weekday: "long" }),
            unix: Math.floor(now.getTime() / 1000),
            timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
          }, null, 2),
        };
        break;
      }
      case "git_status":
      case "git_diff":
      case "git_log":
      case "git_branch":
      case "git_checkout":
      case "git_add":
      case "git_commit":
      case "git_push":
      case "git_pull":
      case "git_fetch":
      case "git_stash":
      case "git_reset":
      case "git_show":
        result = await handleGitTool(msg.tool, msg.args);
        break;
      case "bash":
        result = await handleBash(msg.id, msg.args);
        break;
      default:
        if (msg.tool.startsWith("browser_")) {
          await ensureBrowser();
          result = await handleBrowserTool(msg.tool, msg.args);
        } else {
          result = { success: false, output: "", error: `Unknown tool: ${msg.tool}` };
        }
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
if (config.browser) {
  console.log(`[worker] Browser mode enabled${config.browserProfile ? ` (profile: ${config.browserProfile})` : ""}`);
}

// Graceful shutdown
process.on("SIGINT", () => {
  console.log("\n[worker] Shutting down...");
  for (const [, proc] of activeProcesses) {
    if (proc.pid) killProcessTree(proc.pid);
  }
  if (chromeManager) chromeManager.shutdown().catch(() => {});
  wsSend({ type: "shutdown" });
  setTimeout(() => process.exit(0), 500);
});

process.on("SIGTERM", () => {
  if (chromeManager) chromeManager.shutdown().catch(() => {});
  for (const [, proc] of activeProcesses) {
    if (proc.pid) killProcessTree(proc.pid);
  }
  wsSend({ type: "shutdown" });
  setTimeout(() => process.exit(0), 500);
});

// Start connection
connect();

// Launch browser if --browser flag is set
if (config.browser) {
  (async () => {
    try {
      chromeManager = new ChromeManager(config.browserProfile);
      await chromeManager.launch();
      console.log("[worker] Browser ready");
    } catch (e: any) {
      console.error(`[browser] Failed to launch: ${e.message}`);
      console.error("[browser] Browser tools will not be available");
      chromeManager = null;
    }
  })();
}
