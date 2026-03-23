/**
 * Claude Code tmux monitor
 *
 * Optional tmux session for tailing agent logs in a separate pane.
 */

import { writeFileSync } from "node:fs";
import { hasTmux } from "./claude-code-utils";

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
