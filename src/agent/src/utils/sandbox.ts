/**
 * Shared sandbox utilities for bwrap (bubblewrap) isolation
 *
 * Used by:
 * - jobs/tmux-manager.ts: For job_submit sandboxing
 * - tools/tools.ts: For spawn_agent sandboxing
 */

import { execSync } from "node:child_process";
import { existsSync, writeFileSync, readFileSync, lstatSync, readlinkSync } from "node:fs";
import { dirname } from "node:path";

/**
 * Check if bwrap (bubblewrap) is available on the system
 */
export function isBwrapAvailable(): boolean {
  try {
    execSync("which bwrap", { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/**
 * Get static resolv.conf path for DNS in sandbox
 * Creates a static file with public DNS servers to avoid symlink issues
 */
export function getSandboxResolvConf(): string {
  const uid = process.getuid?.() ?? 1000;
  const runUserDir = `/run/user/${uid}`;
  const resolvPath = `${runUserDir}/clawd-resolv.conf`;
  const actualPath = existsSync(runUserDir) ? resolvPath : "/tmp/clawd-sandbox-resolv.conf";

  if (!existsSync(actualPath)) {
    writeFileSync(actualPath, `nameserver 1.1.1.1\nnameserver 8.8.8.8\n`, { mode: 0o644 });
  }

  return actualPath;
}

export interface BwrapOptions {
  /** Project root directory - will have read/write access */
  projectRoot: string;
  /** Working directory inside sandbox (defaults to projectRoot) */
  workDir?: string;
  /** Additional directories to bind read-write */
  additionalBinds?: string[];
  /** Additional directories to bind read-only */
  additionalRoBinds?: string[];
}

/**
 * Generate bwrap command prefix for sandboxed execution
 *
 * Security features:
 * - Clears all host environment variables
 * - Read-only access to system directories (/usr, /bin, /lib, /etc)
 * - Read-write access only to projectRoot and specified binds
 * - Loads safe environment from ~/.clawd/.env
 * - Tool paths (bun, nvm, cargo, deno) are read-only
 *
 * @param options Sandbox configuration
 * @returns Shell command prefix string for bwrap
 */
export function getBwrapPrefix(options: BwrapOptions): string {
  const { projectRoot, workDir, additionalBinds = [], additionalRoBinds = [] } = options;
  const home = process.env.HOME || "/home/user";
  const sandboxResolvConf = getSandboxResolvConf();

  const args = [
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
    "--ro-bind",
    "/lib64",
    "/lib64",
    "--ro-bind",
    "/etc",
    "/etc",
  ];

  // Handle symlinked resolv.conf (e.g., WSL)
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

  // Additional read-write binds
  for (const bindPath of additionalBinds) {
    if (existsSync(bindPath)) {
      args.push("--bind", bindPath, bindPath);
    }
  }

  // Additional read-only binds
  for (const roBindPath of additionalRoBinds) {
    if (existsSync(roBindPath)) {
      args.push("--ro-bind", roBindPath, roBindPath);
    }
  }

  // Tool paths (read-only)
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

  // Set minimal safe environment
  const safeEnvVars: Record<string, string> = {
    HOME: home,
    USER: process.env.USER || "clawd",
    PATH: `${home}/.clawd/bin:${home}/.bun/bin:${home}/.cargo/bin:${home}/.deno/bin:${home}/.local/bin:/usr/local/bin:/usr/bin:/bin`,
    TERM: process.env.TERM || "xterm-256color",
    LANG: process.env.LANG || "en_US.UTF-8",
    SHELL: "/bin/bash",
    // Git config: use agent-specific gitconfig (since /home is tmpfs, ~/.gitconfig doesn't exist)
    GIT_CONFIG_GLOBAL: `${home}/.clawd/.gitconfig`,
    // SSH config: use agent key, skip host key verification (non-interactive), ignore system known_hosts
    GIT_SSH_COMMAND: `ssh -F /dev/null -o IdentitiesOnly=yes -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -i ${home}/.clawd/.ssh/id_ed25519`,
    // Prevent git from prompting for credentials or confirmations
    GIT_TERMINAL_PROMPT: "0",
  };

  // Load agent's .env file if it exists
  const agentEnvFile = `${home}/.clawd/.env`;
  if (existsSync(agentEnvFile)) {
    try {
      const envContent = readFileSync(agentEnvFile, "utf-8");
      for (const line of envContent.split("\n")) {
        const trimmed = line.trim();
        // Skip empty lines and comments
        if (!trimmed || trimmed.startsWith("#")) continue;
        const eqIndex = trimmed.indexOf("=");
        if (eqIndex > 0) {
          const key = trimmed.slice(0, eqIndex).trim();
          let value = trimmed.slice(eqIndex + 1).trim();
          // Remove surrounding quotes if present
          if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
            value = value.slice(1, -1);
          }
          safeEnvVars[key] = value;
        }
      }
    } catch {
      // Ignore parse errors
    }
  }

  for (const [key, value] of Object.entries(safeEnvVars)) {
    args.push("--setenv", key, value);
  }

  args.push("--die-with-parent", "--chdir", workDir || projectRoot);

  return args.map((a) => `'${a.replace(/'/g, "'\\''")}'`).join(" ");
}

/**
 * Wrap a command with bwrap sandbox
 *
 * @param command The command to run inside the sandbox
 * @param options Sandbox configuration
 * @returns The full sandboxed command, or original command if bwrap unavailable
 */
export function wrapWithSandbox(command: string, options: BwrapOptions): string {
  if (!isBwrapAvailable()) {
    // Fallback if bwrap not available (less secure)
    return command;
  }

  const bwrapPrefix = getBwrapPrefix(options);
  // Escape command for bash -c
  const escapedCommand = command.replace(/'/g, "'\\''");
  return `${bwrapPrefix} bash -c '${escapedCommand}'`;
}
