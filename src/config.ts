/**
 * Configuration for clawd-app
 *
 * Loads settings from environment variables and CLI arguments.
 */

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";

export interface AppConfig {
  /** HTTP server port */
  port: number;
  /** Path to the clawd binary */
  clawdBin: string;
  /** Base URL for the chat API (self) */
  chatApiUrl: string;
  /** Whether to open the browser on startup */
  openBrowser: boolean;
  /** Project root directory (default: cwd) */
  projectRoot: string;
  /** Enable debug logging */
  debug: boolean;
  /** Disable sandbox + unlimited iterations for agents */
  yolo: boolean;
}

/** Parse CLI arguments and build config */
export function loadConfig(): AppConfig {
  let values: {
    port?: string;
    "clawd-bin"?: string;
    "project-root"?: string;
    "no-browser"?: boolean;
    help?: boolean;
    debug?: boolean;
    yolo?: boolean;
  };

  try {
    const parsed = parseArgs({
      args: Bun.argv.slice(2),
      options: {
        port: { type: "string", short: "p" },
        "clawd-bin": { type: "string" },
        "project-root": { type: "string", short: "r" },
        "no-browser": { type: "boolean" },
        help: { type: "boolean", short: "h" },
        debug: { type: "boolean" },
        yolo: { type: "boolean" },
      },
      allowPositionals: false,
    });
    values = parsed.values;
  } catch (error: any) {
    if (error.code === "ERR_PARSE_ARGS_UNKNOWN_OPTION") {
      const match = error.message?.match(/Unknown option '(.+?)'/);
      const unknownOpt = match ? match[1] : "unknown";
      console.error(`Error: Unknown option '${unknownOpt}'`);
      console.error("");
      printUsage();
      process.exit(1);
    }
    throw error;
  }

  if (values.help) {
    printUsage();
    process.exit(0);
  }

  const port = parseInt(values.port || process.env.CHAT_PORT || "3456", 10);
  const clawdBin = values["clawd-bin"] || join(homedir(), ".clawd", "bin", "clawd");
  const projectRoot = values["project-root"] ? resolve(values["project-root"]) : process.cwd();

  return {
    port,
    clawdBin,
    chatApiUrl: `http://localhost:${port}`,
    openBrowser: !values["no-browser"],
    projectRoot,
    debug: values.debug || false,
    yolo: values.yolo || false,
  };
}

/** Check if the clawd binary exists and is executable */
export function validateClawdBin(binPath: string): boolean {
  if (!existsSync(binPath)) {
    console.error(`[clawd-app] Error: clawd binary not found at ${binPath}`);
    console.error(`[clawd-app] Install clawd first: cd ~/.clawd && git clone ... && bun run build`);
    console.error(`[clawd-app] Or specify path: clawd-app --clawd-bin /path/to/clawd`);
    return false;
  }
  return true;
}

function printUsage() {
  console.log(`Claw'd App - All-in-one desktop app

Usage: clawd-app [options]

Options:
  -p, --port <port>            Server port (default: 3456)
  --clawd-bin <path>           Path to clawd binary (default: ~/.clawd/bin/clawd)
  -r, --project-root <path>    Project root directory (default: current directory)
  --no-browser                 Don't open browser on startup
  --yolo                       Disable sandbox + unlimited iterations for agents
  --debug                      Enable debug logging
  -h, --help                   Show this help message

Examples:
  clawd-app
  clawd-app --port 8080
  clawd-app --project-root /path/to/project
  clawd-app --no-browser --debug
`);
}


