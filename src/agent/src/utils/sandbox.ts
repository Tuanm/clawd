/**
 * Cross-platform sandbox utilities
 *
 * Linux: bubblewrap (bwrap) - deny-by-default namespace isolation
 * macOS: sandbox-exec with Seatbelt profiles - allow-default, deny-writes approach
 *
 * Security model:
 * - Write access: only projectRoot (excluding .clawd/), /tmp, and ~/.clawd
 * - Read access (Linux): only explicitly mounted system paths
 * - Read access (macOS): system-wide reads allowed (required by dyld), home dir blocked
 * - Home directory: blocked except for specific tool dirs (.bun, .cargo, .clawd, etc.)
 * - {projectRoot}/.clawd/: blocked (agent config/identity, roles, agents.json)
 * - Environment: wiped clean and rebuilt with only safe variables
 */

import { spawn, execSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, lstatSync, readlinkSync, realpathSync } from "node:fs";
import { homedir, platform, userInfo } from "node:os";
import { resolve, join, dirname } from "node:path";
import { getAgentContext } from "./agent-context";

// ============================================================================
// State
// ============================================================================

let sandboxInitialized = false;
// NOTE: sandboxProjectRoot is now primarily read from AgentContext for concurrent agent support.
// This fallback is kept for backward compatibility with CLI mode (single agent).
let sandboxProjectRootFallback: string = "";
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
  const home = homedir();
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
  const home = homedir();

  const env: Record<string, string> = {
    HOME: home,
    USER: (() => {
      try {
        return userInfo().username;
      } catch {
        return "clawd";
      }
    })(),
    PATH: `${home}/.clawd/bin:${home}/.bun/bin:${home}/.cargo/bin:${home}/.deno/bin:${home}/.local/bin:/usr/local/bin:/usr/bin:/bin`,
    TERM: "xterm-256color",
    LANG: "C.UTF-8",
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
  const home = homedir();
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

  // Block access to {projectRoot}/.clawd/ — agent config/identity must not be tampered with
  const projectClawdDir = join(projectRoot, ".clawd");
  if (existsSync(projectClawdDir)) {
    args.push("--tmpfs", projectClawdDir);
    // Re-mount skills/ read-only so agents can read SKILL.md and execute skill scripts
    const skillsDir = join(projectClawdDir, "skills");
    if (existsSync(skillsDir)) args.push("--ro-bind", skillsDir, skillsDir);
    // Re-mount tools/ read-only so custom tool entrypoints can be executed
    const toolsDir = join(projectClawdDir, "tools");
    if (existsSync(toolsDir)) args.push("--ro-bind", toolsDir, toolsDir);
  }

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
 * Resolve a path to its real path on macOS (handles /tmp -> /private/tmp, etc.)
 * Returns the original path if realpath fails (e.g., path doesn't exist yet).
 */
function safeRealpath(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

/**
 * Generate a Seatbelt profile for macOS sandbox-exec.
 *
 * Strategy: allow-default with deny-writes (like Gemini CLI's "permissive" profile).
 *
 * A pure (deny default) approach is impractical on macOS because it requires
 * enumerating all dyld shared cache paths, system frameworks, mach services,
 * sysctl names, etc. -- any of which can change between macOS versions and
 * cause mysterious "Abort trap: 6" crashes.
 *
 * Instead we:
 * 1. (allow default) -- allow reads and process execution
 * 2. (deny file-write*) -- deny all writes by default
 * 3. Explicitly allow writes only to projectRoot and /tmp
 *
 * This matches the security intent: agents can READ system files (needed for
 * running commands) but can only WRITE to the project directory and temp files.
 *
 * NOTE: On macOS, /tmp is a symlink to /private/tmp, /etc to /private/etc, etc.
 * Seatbelt operates on real paths, so we must use /private/tmp in the profile.
 * We use sandbox-exec -D params to pass resolved paths into the profile.
 */
function getMacOSSandboxProfile(): string {
  return `(version 1)

; Allow everything by default (reads, process exec, mach lookups, etc.)
(allow default)

; ====================================================================
; DENY all file writes -- then selectively re-enable for safe paths
; ====================================================================
(deny file-write*)

; Project root (read-write)
(allow file-write*
  (subpath (param "PROJECT_DIR")))

; Block writes to {projectRoot}/.clawd/ — agent config/identity must not be tampered with
(deny file-write*
  (subpath (string-append (param "PROJECT_DIR") "/.clawd")))

; Allow read + execute for .clawd/skills/ (skill scripts)
(allow file-read*
  (subpath (string-append (param "PROJECT_DIR") "/.clawd/skills")))
(allow process-exec
  (subpath (string-append (param "PROJECT_DIR") "/.clawd/skills")))

; Allow read + execute for .clawd/tools/ (custom tool entrypoints)
(allow file-read*
  (subpath (string-append (param "PROJECT_DIR") "/.clawd/tools")))
(allow process-exec
  (subpath (string-append (param "PROJECT_DIR") "/.clawd/tools")))

; /tmp (read-write) -- use real path (/private/tmp on macOS)
(allow file-write*
  (subpath (param "TMP_DIR")))

; Tool config dirs that may need write access
(allow file-write*
  (subpath (param "CLAWD_DIR")))

; Allow writes to /dev pseudo-devices
(allow file-write*
  (literal "/dev/stdout")
  (literal "/dev/stderr")
  (literal "/dev/null")
  (literal "/dev/ptmx")
  (regex #"^/dev/ttys[0-9]*$"))

; ====================================================================
; DENY reads to sensitive home directory paths
; (allow default already permits reads, but we restrict sensitive areas)
; ====================================================================
; Block reading SSH keys, cloud credentials, browser data, etc.
; Note: we re-allow specific tool paths below
(deny file-read*
  (subpath (param "HOME_DIR"))
  (subpath (param "PRIVATE_HOME_DIR")))

; Re-allow reading specific tool directories under home
(allow file-read*
  (subpath (param "CLAWD_DIR"))
  (subpath (param "PROJECT_DIR")))

; Re-allow common development tool directories (read-only)
; These exist under HOME_DIR but need to be readable for toolchains
(allow file-read*
  (subpath (string-append (param "HOME_DIR") "/.bun"))
  (subpath (string-append (param "HOME_DIR") "/.nvm"))
  (subpath (string-append (param "HOME_DIR") "/.cargo"))
  (subpath (string-append (param "HOME_DIR") "/.deno"))
  (subpath (string-append (param "HOME_DIR") "/.local"))
  (subpath (string-append (param "HOME_DIR") "/.npm"))
  (subpath (string-append (param "HOME_DIR") "/.config"))
  (subpath (string-append (param "HOME_DIR") "/.gitconfig")))

; Allow all network access (agents need git, web fetch, APIs)
(allow network*)
`;
}

/**
 * Build the command prefix for macOS sandboxed execution.
 * Uses env -i for clean environment + sandbox-exec with -D params for path injection.
 */
function getMacOSCommandPrefix(workDir: string): string {
  const profile = getMacOSSandboxProfile();
  const profilePath = "/tmp/clawd-sandbox.sb";
  writeFileSync(profilePath, profile, { mode: 0o644 });

  const home = homedir();

  // Resolve real paths -- macOS symlinks /tmp -> /private/tmp, /etc -> /private/etc
  // Use getSandboxProjectRoot() to get the correct project root for this agent
  const realProjectDir = safeRealpath(getSandboxProjectRoot());
  const realTmpDir = safeRealpath("/tmp");
  const realHomeDir = safeRealpath(home);
  const realClawdDir = safeRealpath(join(home, ".clawd"));

  // /Users is the real path; /private/Users doesn't exist, but handle it for safety
  const privateHomeDir = realHomeDir.startsWith("/private") ? realHomeDir : `/private${realHomeDir}`;

  const envPrefix = getEnvPrefix();

  // Use -D params to inject resolved paths into the Seatbelt profile
  const dParams = [
    `-D PROJECT_DIR=${realProjectDir}`,
    `-D TMP_DIR=${realTmpDir}`,
    `-D HOME_DIR=${realHomeDir}`,
    `-D PRIVATE_HOME_DIR=${privateHomeDir}`,
    `-D CLAWD_DIR=${realClawdDir}`,
  ].join(" ");

  return `${envPrefix} sandbox-exec ${dParams} -f ${profilePath} bash -c`;
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

  // Store as fallback for CLI mode (single agent without context)
  sandboxProjectRootFallback = resolve(projectRoot);
  const plat = detectPlatform();

  if (plat === "linux" && isBwrapAvailable()) {
    sandboxInitialized = true;
    sandboxIsEnabled = true;
    console.error(`[Sandbox] Enabled via bwrap, restricted to: ${sandboxProjectRootFallback}, /tmp`);
    console.error(`[Sandbox] Use --yolo to disable restrictions`);
  } else if (plat === "macos" && isSandboxExecAvailable()) {
    sandboxInitialized = true;
    sandboxIsEnabled = true;
    console.error(`[Sandbox] Enabled via sandbox-exec, restricted to: ${sandboxProjectRootFallback}, /tmp`);
    console.error(`[Sandbox] Use --yolo to disable restrictions`);
  } else {
    console.error(`[Sandbox] No supported sandbox available (platform: ${plat}), running without sandbox`);
    sandboxIsEnabled = false;
  }
}

/**
 * Set the sandbox project root (used by CLI mode for single agent).
 * In clawd-app mode with multiple agents, use runWithAgentContext instead.
 */
export function setSandboxProjectRoot(root: string) {
  sandboxProjectRootFallback = resolve(root);
}

/**
 * Get the sandbox project root.
 * In clawd-app mode: returns value from AgentContext (per-agent isolation).
 * In CLI mode: returns the fallback global value.
 */
export function getSandboxProjectRoot(): string {
  // First try to get from AgentContext (concurrent agent support)
  const ctx = getAgentContext();
  if (ctx?.projectRoot) {
    return ctx.projectRoot;
  }
  // Fallback to global (CLI mode / backward compatibility)
  if (!sandboxProjectRootFallback) {
    sandboxProjectRootFallback = process.cwd();
  }
  return sandboxProjectRootFallback;
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
// Path Validation
// ============================================================================

/**
 * Validate that a working directory is within allowed boundaries.
 * Security: This is a defense-in-depth check that runs BEFORE sandbox wrapping.
 * The sandbox itself provides kernel-level enforcement, but this catches
 * invalid paths early with clear error messages.
 *
 * Allowed paths:
 * - Within projectRoot (the agent's assigned project directory)
 * - Within /tmp (for temporary files)
 *
 * Security considerations:
 * - Uses realpath resolution to prevent symlink traversal attacks
 * - Normalizes paths to prevent ../ traversal
 * - Fails closed (throws on any validation error)
 *
 * @param cwd - The working directory to validate
 * @param projectRoot - The agent's project root
 * @throws Error if cwd is outside allowed boundaries
 */
function validateWorkingDirectory(cwd: string, projectRoot: string): void {
  // Resolve to absolute path, normalizing any ../ sequences
  let resolvedCwd: string;
  try {
    // Use resolve first (works even if path doesn't exist yet)
    resolvedCwd = resolve(cwd);

    // If path exists, also verify via realpath to catch symlink attacks
    if (existsSync(cwd)) {
      const realCwd = realpathSync(cwd);
      // If realpath differs significantly from resolved path, it's a symlink
      // that might be trying to escape. Use the realpath for validation.
      resolvedCwd = realCwd;
    }
  } catch (err) {
    // If we can't resolve the path, fail closed
    throw new Error(`SANDBOX SECURITY: Cannot resolve working directory "${cwd}": ${err}`);
  }

  // Normalize projectRoot too
  const resolvedProjectRoot = resolve(projectRoot);

  // Check if cwd is within allowed boundaries
  const isWithinProjectRoot = resolvedCwd === resolvedProjectRoot || resolvedCwd.startsWith(`${resolvedProjectRoot}/`);
  const isWithinTmp = resolvedCwd === "/tmp" || resolvedCwd.startsWith("/tmp/");

  // Block access to {projectRoot}/.clawd/ — agent config/identity must not be tampered with
  const isClawdDir =
    resolvedCwd === `${resolvedProjectRoot}/.clawd` || resolvedCwd.startsWith(`${resolvedProjectRoot}/.clawd/`);

  if (isClawdDir) {
    throw new Error(
      `SANDBOX SECURITY: Working directory "${cwd}" is inside .clawd/ which contains agent configuration. ` +
        `Direct access to .clawd/ is not allowed — use the provided tools instead.`,
    );
  }

  if (!isWithinProjectRoot && !isWithinTmp) {
    throw new Error(
      `SANDBOX SECURITY: Working directory "${cwd}" (resolved: "${resolvedCwd}") is outside allowed boundaries. ` +
        `Allowed: ${resolvedProjectRoot} or /tmp. ` +
        `This is a security restriction to prevent unauthorized file system access.`,
    );
  }
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
 * @throws Error if cwd is outside allowed boundaries
 */
export async function wrapCommandForSandbox(command: string, cwd?: string): Promise<string> {
  if (!isSandboxReady()) {
    return command;
  }

  const projectRoot = getSandboxProjectRoot();
  const workDir = cwd || projectRoot;

  // SECURITY: Validate working directory before sandbox wrapping
  // This is defense-in-depth - the sandbox also enforces boundaries at kernel level
  validateWorkingDirectory(workDir, projectRoot);
  const plat = detectPlatform();
  const escapedCmd = command.replace(/'/g, "'\\''");

  if (plat === "linux") {
    const bwrapPrefix = getBwrapPrefix({ projectRoot, workDir });
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
  options: { timeout?: number; cwd?: string; stdin?: string } = {},
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
      stdio: [options.stdin !== undefined ? "pipe" : "ignore", "pipe", "pipe"],
    });

    // Write stdin data if provided
    if (options.stdin !== undefined && proc.stdin) {
      proc.stdin.on("error", () => {}); // Ignore EPIPE if process dies early
      proc.stdin.write(options.stdin);
      proc.stdin.end();
    }

    let timedOut = false;
    const timeoutId = setTimeout(() => {
      timedOut = true;
      proc.kill("SIGKILL");
    }, timeout);

    let stdout = "";
    let stderr = "";
    const MAX_COLLECT = 10 * 1024 * 1024; // 10MB safety cap

    proc.stdout?.on("data", (data: Buffer) => {
      if (stdout.length < MAX_COLLECT) stdout += data.toString();
    });
    proc.stderr?.on("data", (data: Buffer) => {
      if (stderr.length < MAX_COLLECT) stderr += data.toString();
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
