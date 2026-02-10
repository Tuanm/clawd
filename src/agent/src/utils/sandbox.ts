/**
 * Cross-platform sandbox utilities
 *
 * Linux: bubblewrap (bwrap) - deny-by-default namespace isolation
 * macOS: sandbox-exec with Seatbelt profiles - deny-by-default policy
 *
 * Security: Only projectRoot and /tmp are writable. Only necessary system
 * paths (/usr, /bin, /lib, /etc) are readable. Environment is wiped clean.
 */

import { spawn, execSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, lstatSync, readlinkSync } from "node:fs";
import { homedir, platform } from "node:os";
import { resolve, join, dirname } from "node:path";

// ============================================================================
// State
// ============================================================================

let sandboxInitialized = false;
let sandboxProjectRoot: string = "";
let sandboxIsEnabled: boolean = false;

// Cached agent environment variables (loaded once at startup)
let agentEnvCache: Record<string, string> | null = null;

// ============================================================================
// Environment Variable Handling
// ============================================================================

/**
 * Load agent environment variables from ~/.clawd/.env
 * These are injected into the sandbox environment.
 */
function loadAgentEnv(): Record<string, string> {
  if (agentEnvCache !== null) return agentEnvCache;

  agentEnvCache = {};
  const home = process.env.HOME || homedir();
  const agentEnvFile = `${home}/.clawd/.env`;

  if (existsSync(agentEnvFile)) {
    try {
      const envContent = readFileSync(agentEnvFile, "utf-8");
      for (const line of envContent.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) continue;
        const eqIndex = trimmed.indexOf("=");
        if (eqIndex > 0) {
          const key = trimmed.slice(0, eqIndex).trim();
          let value = trimmed.slice(eqIndex + 1).trim();
          if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
            value = value.slice(1, -1);
          }
          agentEnvCache[key] = value;
        }
      }
    } catch {
      // Ignore parse errors
    }
  }

  return agentEnvCache;
}

/**
 * Build the safe environment variables for sandboxed execution.
 * These are the only env vars available inside the sandbox.
 */
export function getSafeEnvVars(): Record<string, string> {
  const home = process.env.HOME || homedir();

  const env: Record<string, string> = {
    HOME: home,
    USER: process.env.USER || "clawd",
    PATH: `${home}/.clawd/bin:${home}/.bun/bin:${home}/.cargo/bin:${home}/.deno/bin:${home}/.local/bin:/usr/local/bin:/usr/bin:/bin`,
    TERM: process.env.TERM || "xterm-256color",
    LANG: process.env.LANG || "C.UTF-8",
    SHELL: "/bin/bash",
    GIT_CONFIG_GLOBAL: `${home}/.clawd/.gitconfig`,
    GIT_SSH_COMMAND: `ssh -F /dev/null -o IdentitiesOnly=yes -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -i ${home}/.clawd/.ssh/id_ed25519`,
    GIT_TERMINAL_PROMPT: "0",
    ...loadAgentEnv(),
  };

  return env;
}

// ============================================================================
// Platform Detection
// ============================================================================

function detectPlatform(): "linux" | "macos" | "unsupported" {
  const p = platform();
  if (p === "linux") return "linux";
  if (p === "darwin") return "macos";
  return "unsupported";
}

function isBwrapAvailable(): boolean {
  try {
    execSync("which bwrap", { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function isSandboxExecAvailable(): boolean {
  try {
    execSync("which sandbox-exec", { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

// ============================================================================
// Linux: Bubblewrap (bwrap)
// ============================================================================

/**
 * Get static resolv.conf path for DNS in sandbox.
 * Creates a static file with public DNS servers to avoid symlink issues.
 */
function getSandboxResolvConf(): string {
  const uid = process.getuid?.() ?? 1000;
  const runUserDir = `/run/user/${uid}`;
  const resolvPath = `${runUserDir}/clawd-resolv.conf`;
  const actualPath = existsSync(runUserDir) ? resolvPath : "/tmp/clawd-sandbox-resolv.conf";

  if (!existsSync(actualPath)) {
    writeFileSync(actualPath, "nameserver 1.1.1.1\nnameserver 8.8.8.8\n", { mode: 0o644 });
  }

  return actualPath;
}

/**
 * Build an `env -i VAR=val ...` prefix string for environment isolation.
 * This ensures the sandbox starts with a clean environment containing only safe vars.
 */
function getEnvPrefix(): string {
  const env = getSafeEnvVars();
  const parts = ["env", "-i"];

  for (const [key, value] of Object.entries(env)) {
    const escaped = value.replace(/'/g, "'\\''");
    parts.push(`${key}='${escaped}'`);
  }

  return parts.join(" ");
}

interface BwrapOptions {
  projectRoot: string;
  workDir?: string;
}

/**
 * Generate bwrap command prefix for sandboxed execution.
 *
 * Deny-by-default: only explicitly listed paths are accessible.
 * - /usr, /bin, /lib, /lib64, /etc: read-only (system binaries and config)
 * - projectRoot: read-write (agent workspace)
 * - /tmp: read-write (temporary files)
 * - ~/.bun, ~/.nvm, ~/.cargo, ~/.deno, ~/.local, ~/.clawd: read-only (tools)
 * - /home is a tmpfs (blocks access to home directory)
 * - Environment is cleared and rebuilt with only safe variables
 */
function getBwrapPrefix(options: BwrapOptions): string {
  const { projectRoot, workDir } = options;
  const home = process.env.HOME || homedir();
  const sandboxResolvConf = getSandboxResolvConf();

  const args: string[] = [
    "bwrap",
    "--ro-bind",
    "/usr",
    "/usr",
    "--ro-bind",
    "/bin",
    "/bin",
    "--ro-bind",
    "/lib",
    "/lib",
  ];

  // /lib64 may not exist on all systems
  if (existsSync("/lib64")) {
    args.push("--ro-bind", "/lib64", "/lib64");
  }

  args.push("--ro-bind", "/etc", "/etc");

  // Handle symlinked resolv.conf (e.g., WSL uses /run/resolvconf/resolv.conf)
  try {
    const resolvStat = lstatSync("/etc/resolv.conf");
    if (resolvStat.isSymbolicLink()) {
      const target = readlinkSync("/etc/resolv.conf");
      const parentDir = dirname(target);
      args.push("--tmpfs", parentDir);
      args.push("--ro-bind", sandboxResolvConf, target);
    } else {
      args.push("--ro-bind", sandboxResolvConf, "/etc/resolv.conf");
    }
  } catch {
    args.push("--ro-bind", sandboxResolvConf, "/etc/resolv.conf");
  }

  args.push(
    "--dev",
    "/dev",
    "--proc",
    "/proc",
    "--tmpfs",
    "/home",
    "--bind",
    projectRoot,
    projectRoot,
    "--bind",
    "/tmp",
    "/tmp",
  );

  // Tool paths (read-only) - only mount if they exist
  const toolPaths = [
    `${home}/.bun`,
    `${home}/.nvm`,
    `${home}/.cargo`,
    `${home}/.deno`,
    `${home}/.local`,
    `${home}/.clawd/bin`,
    `${home}/.clawd/.ssh`,
    `${home}/.clawd/.gitconfig`,
  ];

  for (const toolPath of toolPaths) {
    if (existsSync(toolPath)) {
      args.push("--ro-bind", toolPath, toolPath);
    }
  }

  // Clear host environment and set only safe variables
  args.push("--clearenv");

  const safeEnv = getSafeEnvVars();
  for (const [key, value] of Object.entries(safeEnv)) {
    args.push("--setenv", key, value);
  }

  args.push("--die-with-parent", "--chdir", workDir || projectRoot);

  // Shell-escape each argument
  return args.map((a) => `'${a.replace(/'/g, "'\\''")}'`).join(" ");
}

// ============================================================================
// macOS: sandbox-exec with Seatbelt profiles
// ============================================================================

/**
 * Generate a deny-default Seatbelt profile for macOS sandbox-exec.
 *
 * Same security posture as bwrap:
 * - Deny everything by default
 * - Allow read-only access to system paths
 * - Allow read-write access only to projectRoot and /tmp
 * - Allow network access (agents need git, API calls, etc.)
 */
function getMacOSSandboxProfile(): string {
  const home = process.env.HOME || homedir();

  const profile = `(version 1)
(deny default)

; Process execution
(allow process-exec)
(allow process-fork)
(allow sysctl-read)
(allow signal (target self))
(allow mach-lookup)
(allow mach-register)
(allow ipc-posix-shm-read-data)
(allow ipc-posix-shm-write-data)
(allow ipc-posix-shm-read-metadata)
(allow ipc-posix-shm-write-unlink)

; Read-only system paths (minimal set)
(allow file-read*
  (subpath "/usr")
  (subpath "/bin")
  (subpath "/sbin")
  (subpath "/Library")
  (subpath "/System")
  (subpath "/etc")
  (subpath "/var")
  (subpath "/dev")
  (subpath "/private/etc")
  (subpath "/private/var"))

; Tool paths (read-only)
(allow file-read*
  (subpath "${home}/.bun")
  (subpath "${home}/.nvm")
  (subpath "${home}/.cargo")
  (subpath "${home}/.deno")
  (subpath "${home}/.local")
  (subpath "${home}/.clawd"))

; Project root (read-write)
(allow file-read* file-write*
  (subpath "${sandboxProjectRoot}"))

; /tmp (read-write)
(allow file-read* file-write*
  (subpath "/tmp")
  (subpath "/private/tmp"))

; Allow network (agents need git, web fetch, APIs)
(allow network*)

; Allow pseudo-terminals
(allow file-read* file-write*
  (literal "/dev/tty")
  (subpath "/dev/ttys")
  (literal "/dev/ptmx")
  (subpath "/dev/fd"))

; Allow reading /dev/urandom, /dev/random
(allow file-read*
  (literal "/dev/urandom")
  (literal "/dev/random")
  (literal "/dev/null")
  (literal "/dev/zero"))
`;

  return profile;
}

/**
 * Build the command prefix for macOS sandboxed execution.
 * Uses env -i for clean environment + sandbox-exec for filesystem isolation.
 */
function getMacOSCommandPrefix(workDir: string): string {
  const profile = getMacOSSandboxProfile();
  const profilePath = "/tmp/clawd-sandbox.sb";
  writeFileSync(profilePath, profile, { mode: 0o644 });

  const envPrefix = getEnvPrefix();
  return `${envPrefix} sandbox-exec -f ${profilePath} bash -c`;
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Initialize the sandbox.
 *
 * Detects platform and available sandbox tool:
 * - Linux: checks for bwrap
 * - macOS: checks for sandbox-exec
 *
 * @param projectRoot - Root directory of the project being worked on
 * @param yolo - If true, sandbox is disabled entirely
 */
export async function initializeSandbox(projectRoot: string, yolo: boolean = false): Promise<void> {
  if (yolo) {
    sandboxIsEnabled = false;
    console.error(`[Sandbox] Disabled (--yolo mode)`);
    return;
  }

  sandboxProjectRoot = resolve(projectRoot);
  const plat = detectPlatform();

  if (plat === "linux" && isBwrapAvailable()) {
    sandboxInitialized = true;
    sandboxIsEnabled = true;
    console.error(`[Sandbox] Enabled via bwrap, restricted to: ${sandboxProjectRoot}, /tmp`);
    console.error(`[Sandbox] Use --yolo to disable restrictions`);
  } else if (plat === "macos" && isSandboxExecAvailable()) {
    sandboxInitialized = true;
    sandboxIsEnabled = true;
    console.error(`[Sandbox] Enabled via sandbox-exec, restricted to: ${sandboxProjectRoot}, /tmp`);
    console.error(`[Sandbox] Use --yolo to disable restrictions`);
  } else {
    console.error(`[Sandbox] No supported sandbox available (platform: ${plat}), running without sandbox`);
    sandboxIsEnabled = false;
  }
}

/**
 * Set the sandbox project root (used by tools.ts for path validation).
 */
export function setSandboxProjectRoot(root: string) {
  sandboxProjectRoot = resolve(root);
}

/**
 * Get the sandbox project root.
 */
export function getSandboxProjectRoot(): string {
  if (!sandboxProjectRoot) {
    sandboxProjectRoot = process.cwd();
  }
  return sandboxProjectRoot;
}

/**
 * Enable or disable sandbox mode.
 */
export function enableSandbox(enabled: boolean = true) {
  sandboxIsEnabled = enabled;
}

/**
 * Check if sandbox is ready for use.
 * Returns true only if sandbox is enabled AND was initialized successfully.
 */
export function isSandboxReady(): boolean {
  return sandboxIsEnabled && sandboxInitialized;
}

/**
 * Check if sandbox is enabled (even if not fully initialized).
 * Used for path validation checks that don't require kernel-level sandboxing.
 */
export function isSandboxEnabled(): boolean {
  return sandboxIsEnabled;
}

// ============================================================================
// Command Wrapping
// ============================================================================

/**
 * Wrap a command string for sandboxed execution.
 *
 * On Linux: wraps with bwrap (namespace isolation + clearenv)
 * On macOS: wraps with env -i + sandbox-exec (Seatbelt profile)
 *
 * @param command - The shell command to wrap
 * @param cwd - Working directory (defaults to project root)
 * @returns The wrapped command string ready for shell execution
 */
export async function wrapCommandForSandbox(command: string, cwd?: string): Promise<string> {
  if (!isSandboxReady()) {
    return command;
  }

  const workDir = cwd || sandboxProjectRoot;
  const plat = detectPlatform();
  const escapedCmd = command.replace(/'/g, "'\\''");

  if (plat === "linux") {
    const bwrapPrefix = getBwrapPrefix({ projectRoot: sandboxProjectRoot, workDir });
    return `${bwrapPrefix} bash -c '${escapedCmd}'`;
  } else if (plat === "macos") {
    const prefix = getMacOSCommandPrefix(workDir);
    return `${prefix} 'cd ${shellEscape(workDir)} && ${escapedCmd}'`;
  }

  return command;
}

/**
 * Run a command inside the sandbox.
 * This is the main function used by tools for sandboxed execution.
 *
 * @param command - Command to execute (e.g., "cat", "rg", "git")
 * @param args - Command arguments
 * @param options - Execution options (timeout, cwd)
 * @returns Promise with stdout, stderr, success, and exit code
 */
export async function runInSandbox(
  command: string,
  args: string[],
  options: { timeout?: number; cwd?: string } = {},
): Promise<{
  success: boolean;
  stdout: string;
  stderr: string;
  code: number | null;
}> {
  const timeout = options.timeout || 30000;

  // Build the command string from command + args
  const cmdParts = [command, ...args.map((a) => shellEscape(a))];
  const cmdString = cmdParts.join(" ");

  // Wrap with sandbox
  const wrappedCommand = await wrapCommandForSandbox(cmdString, options.cwd);

  return new Promise((resolve) => {
    const proc = spawn("bash", ["-c", wrappedCommand], {
      stdio: ["ignore", "pipe", "pipe"],
    });

    let timedOut = false;
    const timeoutId = setTimeout(() => {
      timedOut = true;
      proc.kill("SIGKILL");
    }, timeout);

    let stdout = "";
    let stderr = "";

    proc.stdout?.on("data", (data: Buffer) => {
      stdout += data.toString();
    });
    proc.stderr?.on("data", (data: Buffer) => {
      stderr += data.toString();
    });

    proc.on("close", (code) => {
      clearTimeout(timeoutId);
      if (timedOut) {
        resolve({
          success: false,
          stdout,
          stderr: `TIMEOUT: Command exceeded ${timeout / 1000}s`,
          code: null,
        });
        return;
      }
      resolve({ success: code === 0, stdout, stderr, code });
    });

    proc.on("error", (err) => {
      clearTimeout(timeoutId);
      resolve({ success: false, stdout: "", stderr: err.message, code: null });
    });
  });
}

/**
 * Reset/cleanup sandbox state.
 * Should be called on process exit.
 */
export async function resetSandbox(): Promise<void> {
  sandboxInitialized = false;
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Shell-escape a string for safe inclusion in a shell command.
 */
function shellEscape(str: string): string {
  if (/^[a-zA-Z0-9_./:@=,+-]+$/.test(str)) {
    return str;
  }
  return `'${str.replace(/'/g, "'\\''")}'`;
}
