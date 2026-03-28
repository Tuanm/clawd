/**
 * Shell Tools — today, get_environment, bash, job_submit/status/logs/list/cancel, tmux tools
 *
 * Registers shell execution tools into the shared tool registry.
 * Tmux-dependent tools are only registered when tmux is available.
 */

import { spawn } from "node:child_process";
import {
  IS_WINDOWS,
  getContextAgentId,
  getSafeWindowsShell,
  getSandboxProjectRoot,
  getShellArgs,
  isSandboxEnabled,
  isSandboxReady,
  registerTool,
  resolveSafePath,
  runInSandbox,
  tools,
  validatePath,
  wrapCommandForSandbox,
} from "./registry";
// ============================================================================
// Tool: Today
// ============================================================================

registerTool(
  "today",
  "Get today's date and current time. Use this when you need to know what day it is, the current time, or calculate relative dates.",
  {},
  [],
  async () => {
    const now = new Date();
    const date = now.toLocaleDateString("en-CA"); // YYYY-MM-DD
    const time = now.toLocaleTimeString("en-US", { hour12: false });
    const day = now.toLocaleDateString("en-US", { weekday: "long" });
    return {
      success: true,
      output: `${day}, ${date} ${time}`,
    };
  },
);

// ============================================================================
// Tool: Get Environment (combined system info + project root)
// ============================================================================

registerTool(
  "get_environment",
  "Get working environment: OS, shell, project root, and runtime. Call at session start. All file tools accept relative paths (resolved from project root).",
  {},
  [],
  async () => {
    const os = await import("node:os");
    const platform = os.platform();
    const isWindows = platform === "win32";
    const shell = isWindows ? getSafeWindowsShell() : process.env.SHELL || "/bin/bash";
    const projectRoot = getSandboxProjectRoot();
    return {
      success: true,
      output: JSON.stringify(
        {
          project_root: projectRoot,
          os: platform,
          arch: os.arch(),
          shell,
          shell_type: isWindows
            ? shell.toLowerCase().includes("powershell")
              ? "powershell"
              : "cmd"
            : shell.split("/").pop(),
          user: os.userInfo().username,
          runtime: `Bun ${Bun.version}`,
          hint: isWindows
            ? "Windows machine. Use PowerShell/cmd syntax. File paths accept relative (from project_root) or absolute."
            : "Unix machine. Use bash syntax. File paths accept relative (from project_root) or absolute.",
        },
        null,
        2,
      ),
    };
  },
);

// Backward compatibility aliases
registerTool("get_project_root", "Alias for get_environment.", {}, [], async () =>
  tools.get("get_environment")!({} as any),
);
registerTool("get_system_info", "Alias for get_environment.", {}, [], async () =>
  tools.get("get_environment")!({} as any),
);

/** Maximum bytes to accumulate from a single bash command's stdout+stderr combined */
const MAX_BASH_OUTPUT = 10 * 1024 * 1024; // 10MB

registerTool(
  "bash",
  "Execute a shell command. Use run_in_background=true for long-running commands (returns job ID). Prefer dedicated tools when available: use grep instead of rg/grep, glob instead of find, view instead of cat, edit instead of sed.",
  {
    command: { type: "string", description: "The shell command to execute (use OS-native syntax)" },
    timeout: { type: "number", description: "Timeout in milliseconds (default: 30000, max: 600000)" },
    cwd: { type: "string", description: "Working directory for the command" },
    description: { type: "string", description: "Brief description of what this command does (for logging/audit)" },
    run_in_background: {
      type: "boolean",
      description: "Run command in background (returns immediately with job ID). Use job_status to check output later.",
    },
  },
  ["command"],
  async ({ command, timeout = 30000, cwd, description, run_in_background }) => {
    // Background mode: delegate to job_submit (tmux-based, survives agent exit)
    if (run_in_background) {
      if (!isTmuxAvailable()) {
        return {
          success: false,
          output: "",
          error: "Background execution requires tmux. Install with: apt install tmux (or brew install tmux on macOS)",
        };
      }
      try {
        const { tmuxJobManager } = await import("../jobs/tmux-manager");
        const name = description || command.slice(0, 40).replace(/[^a-zA-Z0-9-_]/g, "_");
        const jobId = tmuxJobManager.submit(name, command);
        return {
          success: true,
          output: `Background job started: ${jobId}\nUse job_status(job_id="${jobId}") to check output.`,
        };
      } catch (err: any) {
        return { success: false, output: "", error: `Failed to start background job: ${err.message}` };
      }
    }
    let workDir = cwd ? resolveSafePath(cwd) : undefined;

    // When sandbox enabled, use platform-specific isolation (bwrap on Linux, sandbox-exec on macOS)
    if (isSandboxEnabled()) {
      const projectRoot = getSandboxProjectRoot();
      workDir = workDir || projectRoot;

      // Validate cwd is within allowed paths
      const cwdError = validatePath(workDir, "bash cwd");
      if (cwdError) {
        return { success: false, output: "", error: cwdError };
      }

      // Block commands that try to access .env files (but allow .env.example)
      const envFilePattern = /(?:^|[^a-zA-Z0-9_.])\.env(?!\.[a-zA-Z]*example)(?:\.[a-zA-Z0-9_]*)?(?:[^a-zA-Z0-9_.]|$)/;
      if (envFilePattern.test(command)) {
        return {
          success: false,
          output: "",
          error:
            "SANDBOX RESTRICTION: Access to .env files is blocked for security reasons. " +
            "These files may contain secrets. Use .env.example as a template instead.",
        };
      }

      const sandboxNotice = `[SANDBOX MODE] You can ONLY access: ${projectRoot} and /tmp. All other paths are blocked.\n\n`;

      // Use kernel-level isolation (bwrap on Linux, sandbox-exec on macOS) if initialized
      if (isSandboxReady()) {
        try {
          const wrappedCommand = await wrapCommandForSandbox(command, workDir);
          return new Promise((resolve) => {
            const proc = spawn("bash", ["-c", wrappedCommand], { timeout }); // lgtm[js/shell-command-injection-from-environment]
            let timedOut = false;

            const timeoutId = setTimeout(() => {
              timedOut = true;
              proc.kill("SIGKILL");
            }, timeout);

            let stdout = "";
            let stderr = "";
            let outputBytes = 0;

            proc.stdout?.on("data", (data: Buffer) => {
              if (outputBytes < MAX_BASH_OUTPUT) {
                stdout += data.toString();
                outputBytes += data.length;
              }
            });
            proc.stderr?.on("data", (data: Buffer) => {
              if (outputBytes < MAX_BASH_OUTPUT) {
                stderr += data.toString();
                outputBytes += data.length;
              }
            });

            proc.on("close", (code: number | null) => {
              clearTimeout(timeoutId);
              const truncated = outputBytes >= MAX_BASH_OUTPUT ? "\n[OUTPUT TRUNCATED: exceeded 10MB limit]" : "";
              if (timedOut) {
                resolve({
                  success: false,
                  output: stdout.trim() + truncated,
                  error:
                    `TIMEOUT: Command exceeded ${timeout / 1000}s limit. ` +
                    `For long-running tasks, use job_submit instead.`,
                });
                return;
              }
              const output = stdout + (stderr ? `\nSTDERR:\n${stderr}` : "") + truncated;
              resolve({
                success: code === 0,
                output: sandboxNotice + (output.trim() || "(no output)"),
                error: code !== 0 ? `Exit code: ${code}` : undefined,
              });
            });

            proc.on("error", (err) => {
              clearTimeout(timeoutId);
              resolve({
                success: false,
                output: "",
                error: `Sandbox error: ${err.message}`,
              });
            });
          });
        } catch (sandboxErr: any) {
          return {
            success: false,
            output: "",
            error: `Sandbox wrapping failed: ${sandboxErr.message}`,
          };
        }
      }
      // Fallback: sandbox enabled but kernel-level sandbox not initialized
      // (e.g., missing dependencies). Still apply path validation above.
    }

    // Non-sandboxed mode - run directly (cross-platform shell)
    return new Promise((resolve) => {
      const [shell, shellArgs] = getShellArgs(command);
      const proc = spawn(shell, shellArgs, {
        timeout,
        cwd: workDir,
        env: {
          ...process.env,
          // Suppress interactive prompts (targeted — don't set CI=true as it breaks tmux/others)
          DEBIAN_FRONTEND: "noninteractive",
          GIT_TERMINAL_PROMPT: "0",
          HOMEBREW_NO_AUTO_UPDATE: "1",
          CONDA_YES: "1",
          PIP_NO_INPUT: "1",
        },
      });
      let timedOut = false;

      const timeoutId = setTimeout(() => {
        timedOut = true;
        proc.kill("SIGKILL");
      }, timeout);

      let stdout = "";
      let stderr = "";
      let outputBytes = 0;

      proc.stdout?.on("data", (data: Buffer) => {
        if (outputBytes < MAX_BASH_OUTPUT) {
          stdout += data.toString();
          outputBytes += data.length;
        }
      });
      proc.stderr?.on("data", (data: Buffer) => {
        if (outputBytes < MAX_BASH_OUTPUT) {
          stderr += data.toString();
          outputBytes += data.length;
        }
      });

      proc.on("close", (code: number | null) => {
        clearTimeout(timeoutId);
        const truncated = outputBytes >= MAX_BASH_OUTPUT ? "\n[OUTPUT TRUNCATED: exceeded 10MB limit]" : "";
        if (timedOut) {
          resolve({
            success: false,
            output: stdout.trim() + truncated,
            error:
              `TIMEOUT: Command exceeded ${timeout / 1000}s limit. ` +
              `For long-running tasks, use job_submit instead.`,
          });
          return;
        }
        const output = stdout + (stderr ? `\nSTDERR:\n${stderr}` : "") + truncated;
        resolve({
          success: code === 0,
          output: output.trim() || "(no output)",
          error: code !== 0 ? `Exit code: ${code}` : undefined,
        });
      });

      proc.on("error", (err) => {
        clearTimeout(timeoutId);
        resolve({
          success: false,
          output: "",
          error: err.message,
        });
      });
    });
  },
);
// ============================================================================
// Tmux availability check (job + tmux tools only registered if tmux is installed)
// ============================================================================

let _tmuxAvailable: boolean | null = null;
function isTmuxAvailable(): boolean {
  if (_tmuxAvailable === null) {
    try {
      const { execSync } = require("node:child_process");
      execSync("which tmux", { stdio: "ignore" });
      _tmuxAvailable = true;
    } catch {
      _tmuxAvailable = false;
    }
  }
  return _tmuxAvailable;
}

if (isTmuxAvailable()) {
  // ============================================================================
  // Tool: Job Submit (tmux-based, survives agent exit)
  // ============================================================================

  registerTool(
    "job_submit",
    "Submit a one-off background command (runs in an isolated tmux session). Returns a job ID. For recurring/scheduled tasks, use schedule_job instead.",
    {
      name: {
        type: "string",
        description: "Short name for the job",
      },
      command: {
        type: "string",
        description: "Bash command to execute",
      },
    },
    ["name", "command"],
    async ({ name, command }) => {
      try {
        const { tmuxJobManager } = await import("../jobs/tmux-manager");

        // When sandbox enabled, wrap the command with platform-specific sandboxing
        // (tmux-manager runs commands directly; sandboxing is enforced here at tool level)
        let sandboxedCommand = command;
        if (isSandboxReady()) {
          sandboxedCommand = await wrapCommandForSandbox(command);
        }

        const jobId = tmuxJobManager.submit(name, sandboxedCommand);

        return {
          success: true,
          output: `Job submitted: ${jobId}\nName: ${name}\nUse job_status or job_logs with this ID to check progress.`,
        };
      } catch (err: any) {
        return { success: false, output: "", error: err.message };
      }
    },
  );

  // ============================================================================
  // Tool: Job Status (tmux-based)
  // ============================================================================

  registerTool(
    "job_status",
    "Get status of one-off background jobs (from job_submit). For recurring scheduled tasks, use schedule_list instead.",
    {
      job_id: {
        type: "string",
        description: "Specific job ID (optional, lists all if not provided)",
      },
      status_filter: {
        type: "string",
        enum: ["pending", "running", "completed", "failed", "cancelled"],
        description: "Filter by status",
      },
    },
    [],
    async ({ job_id, status_filter }) => {
      try {
        const { tmuxJobManager } = await import("../jobs/tmux-manager");

        if (job_id) {
          const job = tmuxJobManager.get(job_id);
          if (!job) {
            return {
              success: false,
              output: "",
              error: `Job ${job_id} not found`,
            };
          }

          // Include logs in detailed view
          const logs = tmuxJobManager.getLogs(job_id, 50);
          const output = [
            JSON.stringify(job, null, 2),
            "",
            "--- Last 50 lines of output ---",
            logs || "(no output yet)",
          ].join("\n");

          return { success: true, output };
        }

        const jobs = tmuxJobManager.list({
          status: status_filter as any,
          limit: 20,
        });

        if (jobs.length === 0) {
          return { success: true, output: "No jobs found." };
        }

        const formatted = jobs
          .map((j) => {
            const elapsed = j.completedAt
              ? `${Math.round((j.completedAt - j.createdAt) / 1000)}s`
              : j.startedAt
                ? `${Math.round((Date.now() - j.startedAt) / 1000)}s (running)`
                : "pending";
            return `[${j.status.toUpperCase()}] ${j.id.slice(0, 8)} - ${j.name} (${elapsed})`;
          })
          .join("\n");

        return { success: true, output: formatted };
      } catch (err: any) {
        return { success: false, output: "", error: err.message };
      }
    },
  );

  // ============================================================================
  // Tool: Job Cancel (tmux-based)
  // ============================================================================

  registerTool(
    "job_cancel",
    "Cancel a one-off background job by its job ID (from job_submit). For recurring schedules, use schedule_cancel instead.",
    {
      job_id: {
        type: "string",
        description: "Job ID to cancel",
      },
    },
    ["job_id"],
    async ({ job_id }) => {
      try {
        const { tmuxJobManager } = await import("../jobs/tmux-manager");

        const cancelled = tmuxJobManager.cancel(job_id);

        if (cancelled) {
          return { success: true, output: `Job ${job_id} cancelled.` };
        } else {
          return {
            success: false,
            output: "",
            error: `Could not cancel job ${job_id} (not running or not found)`,
          };
        }
      } catch (err: any) {
        return { success: false, output: "", error: err.message };
      }
    },
  );

  // ============================================================================
  // Tool: Job Wait (tmux-based)
  // ============================================================================

  registerTool(
    "job_wait",
    "Wait for a job to complete and return its result with full logs.",
    {
      job_id: {
        type: "string",
        description: "Job ID to wait for",
      },
      timeout_ms: {
        type: "number",
        description: "Maximum time to wait in milliseconds (default: 60000)",
      },
    },
    ["job_id"],
    async ({ job_id, timeout_ms = 60000 }) => {
      try {
        const { tmuxJobManager } = await import("../jobs/tmux-manager");

        const job = await tmuxJobManager.waitFor(job_id, timeout_ms);
        const logs = tmuxJobManager.getLogs(job_id);

        if (job.status === "completed") {
          return {
            success: true,
            output: `Job completed (exit code: ${job.exitCode}):\n${logs || "(no output)"}`,
          };
        } else if (job.status === "failed") {
          return {
            success: false,
            output: logs,
            error: `Job failed with exit code: ${job.exitCode}`,
          };
        } else if (job.status === "cancelled") {
          return { success: false, output: logs, error: "Job was cancelled" };
        } else {
          return {
            success: false,
            output: "",
            error: `Job status: ${job.status}`,
          };
        }
      } catch (err: any) {
        return { success: false, output: "", error: err.message };
      }
    },
  );

  // ============================================================================
  // Tool: Job Logs (tmux-based)
  // ============================================================================

  registerTool(
    "job_logs",
    "Get the full output logs of a job.",
    {
      job_id: {
        type: "string",
        description: "Job ID to get logs for",
      },
      tail: {
        type: "number",
        description: "Only get last N lines (optional, returns all if not specified)",
      },
    },
    ["job_id"],
    async ({ job_id, tail }) => {
      try {
        const { tmuxJobManager } = await import("../jobs/tmux-manager");

        const job = tmuxJobManager.get(job_id);
        if (!job) {
          return { success: false, output: "", error: `Job ${job_id} not found` };
        }

        const logs = tmuxJobManager.getLogs(job_id, tail);

        return {
          success: true,
          output: `Job: ${job.name} [${job.status.toUpperCase()}]\nCommand: ${job.command}\n\n--- Output ---\n${logs || "(no output yet)"}`,
        };
      } catch (err: any) {
        return { success: false, output: "", error: err.message };
      }
    },
  );
} // end if (isTmuxAvailable()) — job tools

// ============================================================================
// Tmux Tools
// ============================================================================

/**
 * Execute a tmux command with proper environment
 */
async function execTmux(args: string[]): Promise<{ success: boolean; output: string; error?: string }> {
  return new Promise((resolve) => {
    const proc = spawn("tmux", args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, TERM: "xterm-256color" },
      timeout: 10000,
    });

    let stdout = "";
    let stderr = "";

    proc.stdout.on("data", (data) => {
      stdout += data.toString();
    });

    proc.stderr.on("data", (data) => {
      stderr += data.toString();
    });

    proc.on("close", (code) => {
      if (code === 0) {
        resolve({ success: true, output: stdout.trim() });
      } else {
        resolve({ success: false, output: stdout.trim(), error: stderr.trim() || `tmux exited with code ${code}` });
      }
    });

    proc.on("error", (err) => {
      resolve({ success: false, output: "", error: err.message });
    });
  });
}

/**
 * Get the agent-specific tmux socket name
 * Uses project hash + agent ID for full isolation between agents
 */
function getTmuxSocket(): string {
  const projectRoot = getSandboxProjectRoot();
  const agentId = getContextAgentId() || "default";
  // Create a safe socket name from project path hash and agent ID
  const hash = projectRoot.replace(/[^a-zA-Z0-9]/g, "_").slice(-20);
  const safeAgent = agentId.replace(/[^a-zA-Z0-9]/g, "_").slice(-20);
  return `clawd_${hash}_${safeAgent}`;
}

if (isTmuxAvailable()) {
  /**
   * Run command in tmux session (new or existing)
   */
  registerTool(
    "tmux_send_command",
    "Send a command to a tmux session. Creates session if it doesn't exist. Use this to run long-running processes, servers, or interactive programs in a persistent tmux session.",
    {
      session: { type: "string", description: "Session name (alphanumeric, no spaces)" },
      command: { type: "string", description: "Command to run" },
      cwd: { type: "string", description: "Working directory (defaults to project root)" },
    },
    ["session", "command"],
    async ({ session, command, cwd }) => {
      // Validate session name
      if (!/^[a-zA-Z0-9_-]+$/.test(session)) {
        return { success: false, error: "Session name must be alphanumeric (a-z, A-Z, 0-9, _, -)", output: "" };
      }

      const projectRoot = getSandboxProjectRoot();
      const workDir = cwd || projectRoot;
      const socket = getTmuxSocket();

      // Check if session exists
      const listResult = await execTmux(["-L", socket, "list-sessions", "-F", "#{session_name}"]);
      const sessions = listResult.success ? listResult.output.split("\n").filter(Boolean) : [];
      const sessionExists = sessions.includes(session);

      // Build the command - cd to workdir first
      const cdCmd = `cd "${workDir}" && ${command}`;

      if (!sessionExists) {
        // Create new session and send command
        const createResult = await execTmux(["-L", socket, "new-session", "-d", "-s", session, cdCmd]);
        if (!createResult.success) {
          return { success: false, error: createResult.error || "Failed to create session", output: "" };
        }
        return {
          success: true,
          output: JSON.stringify({
            session,
            status: "created",
            command: command.slice(0, 100) + (command.length > 100 ? "..." : ""),
            cwd: workDir,
          }),
        };
      } else {
        // Send command to existing session (run in the default pane)
        const sendResult = await execTmux(["-L", socket, "send-keys", "-t", session, cdCmd, "C-m"]);
        if (!sendResult.success) {
          return { success: false, error: sendResult.error || "Failed to send command", output: "" };
        }
        return {
          success: true,
          output: JSON.stringify({
            session,
            status: "command_sent",
            command: command.slice(0, 100) + (command.length > 100 ? "..." : ""),
          }),
        };
      }
    },
  );

  /**
   * List tmux sessions for this project
   */
  registerTool(
    "tmux_list",
    "List all tmux sessions for this project. Shows session names and their current state.",
    {},
    [],
    async () => {
      const socket = getTmuxSocket();

      // List sessions with details
      const result = await execTmux([
        "-L",
        socket,
        "list-sessions",
        "-F",
        "#{session_name}|#{session_created}|#{session_windows}",
      ]);

      if (!result.success || !result.output) {
        return {
          success: true,
          output: JSON.stringify({ sessions: [], message: "No tmux sessions for this project" }),
        };
      }

      const sessions = result.output
        .split("\n")
        .filter(Boolean)
        .map((line) => {
          const [name, created, windows] = line.split("|");
          return { name, created, windows };
        });

      return {
        success: true,
        output: JSON.stringify({ sessions }),
      };
    },
  );

  /**
   * Kill a tmux session
   */
  registerTool(
    "tmux_kill",
    "Kill a tmux session. This terminates the session and all processes running in it.",
    {
      session: { type: "string", description: "Session name to kill" },
    },
    ["session"],
    async ({ session }) => {
      const socket = getTmuxSocket();

      const result = await execTmux(["-L", socket, "kill-session", "-t", session]);

      if (!result.success) {
        return { success: false, error: result.error || "Failed to kill session", output: "" };
      }

      return {
        success: true,
        output: JSON.stringify({ session, status: "killed" }),
      };
    },
  );

  /**
   * Capture tmux pane output
   */
  registerTool(
    "tmux_capture",
    "Capture the visible output from a tmux session pane. Useful for seeing the output of long-running programs or interactive sessions.",
    {
      session: { type: "string", description: "Session name" },
      clear: { type: "boolean", description: "Clear the pane history after capturing" },
    },
    ["session"],
    async ({ session, clear = false }) => {
      const socket = getTmuxSocket();

      // Capture pane content
      const captureArgs = ["-L", socket, "capture-pane", "-t", session, "-p"];
      if (clear) {
        captureArgs.push("-C"); // Clear history after capture
      }

      const result = await execTmux(captureArgs);

      if (!result.success) {
        return { success: false, error: result.error || "Failed to capture pane", output: "" };
      }

      return {
        success: true,
        output: JSON.stringify({
          session,
          output: result.output,
          truncated: result.output.length > 50000,
        }),
      };
    },
  );

  /**
   * Send raw input to tmux session
   */
  registerTool(
    "tmux_send_input",
    "Send raw keystrokes to a tmux session. Use this to interact with interactive programs (vim, nano, less, etc.). Send special keys using: Enter= C-m, Tab= C-i, Esc= C-[, Arrow keys= A-up, A-down, etc.",
    {
      session: { type: "string", description: "Session name" },
      keys: {
        type: "string",
        description: "Keys to send (supports special keys: C-m=Enter, C-i=Tab, C-[=Esc, A-up=Up arrow, etc.)",
      },
    },
    ["session", "keys"],
    async ({ session, keys }) => {
      const socket = getTmuxSocket();

      // Convert special key notation
      const parsedKeys = keys
        .replace(/C-m/gi, "Enter")
        .replace(/C-i/gi, "Tab")
        .replace(/C-\[/gi, "Escape")
        .replace(/C-c/gi, "C-c")
        .replace(/C-d/gi, "C-d")
        .replace(/A-/gi, "A-");

      const result = await execTmux(["-L", socket, "send-keys", "-t", session, parsedKeys, "Enter"]);

      if (!result.success) {
        return { success: false, error: result.error || "Failed to send keys", output: "" };
      }

      return {
        success: true,
        output: JSON.stringify({
          session,
          keys_sent: keys,
          status: "sent",
        }),
      };
    },
  );

  /**
   * Create a new window in a tmux session
   */
  registerTool(
    "tmux_new_window",
    "Create a new window in an existing tmux session.",
    {
      session: { type: "string", description: "Session name" },
      window: { type: "string", description: "Window name (optional)" },
      command: { type: "string", description: "Command to run in window (optional)" },
    },
    ["session"],
    async ({ session, window, command }) => {
      const socket = getTmuxSocket();

      const args = ["-L", socket, "new-window", "-t", session];
      if (window) args.push("-n", window);
      if (command) args.push(command);

      const result = await execTmux(args);

      if (!result.success) {
        return { success: false, error: result.error || "Failed to create window", output: "" };
      }

      return {
        success: true,
        output: JSON.stringify({
          session,
          window: window || result.output.trim(),
          status: "created",
        }),
      };
    },
  );

  /**
   * Kill a window in a tmux session
   */
  registerTool(
    "tmux_kill_window",
    "Kill a specific window in a tmux session.",
    {
      session: { type: "string", description: "Session name" },
      window: { type: "string", description: "Window name or index (e.g., 0, 1, or window name)" },
    },
    ["session", "window"],
    async ({ session, window }) => {
      const socket = getTmuxSocket();

      const result = await execTmux(["-L", socket, "kill-window", "-t", `${session}:${window}`]);

      if (!result.success) {
        return { success: false, error: result.error || "Failed to kill window", output: "" };
      }

      return {
        success: true,
        output: JSON.stringify({
          session,
          window,
          status: "killed",
        }),
      };
    },
  );
} // end if (isTmuxAvailable()) — tmux tools
