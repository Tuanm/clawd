/**
 * Claude Code tmux monitor
 *
 * Optional tmux session for tailing agent logs in a separate pane.
 */

import { writeFileSync } from "node:fs";
import { hasTmux } from "./utils";

export interface TmuxMonitor {
  session: string | null;
  logFilePath: string;
}

export function startTmuxMonitor(label: string, logFilePath: string): TmuxMonitor {
  if (!hasTmux()) return { session: null, logFilePath };

  const session = `clawd-${label}`;
  try {
    writeFileSync(logFilePath, "");
    Bun.spawnSync(["tmux", "new-session", "-d", "-s", session, "-x", "200", "-y", "50", `tail -f ${logFilePath}`]);
    console.log(`[claude-code] tmux: ${session}`);
    return { session, logFilePath };
  } catch {
    return { session: null, logFilePath };
  }
}

export function stopTmuxMonitor(monitor: TmuxMonitor): void {
  if (monitor.session) {
    try {
      Bun.spawnSync(["tmux", "kill-session", "-t", monitor.session]);
    } catch {}
    monitor.session = null;
  }
}

/** Kill orphaned clawd-cc-* tmux sessions from previous runs */
export function cleanupStaleTmuxSessions(): void {
  if (!hasTmux()) return;
  try {
    const result = Bun.spawnSync(["tmux", "list-sessions", "-F", "#{session_name}"]);
    if (result.exitCode !== 0) return;
    const sessions = result.stdout
      .toString()
      .split("\n")
      .filter((s) => s.startsWith("clawd-cc-"));
    for (const session of sessions) {
      try {
        Bun.spawnSync(["tmux", "kill-session", "-t", session]);
      } catch {}
    }
    if (sessions.length > 0) {
      console.log(`[claude-code] Cleaned up ${sessions.length} orphaned tmux session(s)`);
    }
  } catch {}
}
