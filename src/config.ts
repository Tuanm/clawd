/**
 * Configuration for clawd-app
 *
 * Loads settings from CLI flags and ~/.clawd/config.json.
 * The agent runs in-process (no separate clawd binary needed).
 */

import { parseArgs } from "node:util";
import { loadConfigFile } from "./config-file";

export interface AppConfig {
  /** HTTP server host */
  host: string;
  /** HTTP server port */
  port: number;
  /** Base URL for the chat API (self) */
  chatApiUrl: string;
  /** Whether to open the browser on startup */
  openBrowser: boolean;
  /** Default project root directory (fallback for agents without project config) */
  projectRoot: string;
  /** Enable debug logging */
  debug: boolean;
  /** Disable sandbox + unlimited iterations for agents */
  yolo: boolean;
  /** Enable context mode */
  contextMode: boolean;
  /** Heartbeat monitor configuration for stuck agent recovery */
  heartbeat?: {
    /** Enable the heartbeat monitor (default: true) */
    enabled?: boolean;
    /** How often to check agent health in ms (default: 30000) */
    intervalMs?: number;
    /** Cancel agent processing after this many ms (default: 300000) */
    processingTimeoutMs?: number;
    /** Inject heartbeat for idle space agents after this many ms (default: 60000) */
    spaceIdleTimeoutMs?: number;
  };
}

/** Parse CLI arguments and build config */
export function loadConfig(): AppConfig {
  let values: {
    host?: string;
    port?: string;
    "no-open-browser"?: boolean;
    restart?: boolean;
    help?: boolean;
    debug?: boolean;
    yolo?: boolean;
  };

  try {
    const parsed = parseArgs({
      args: Bun.argv.slice(2),
      options: {
        host: { type: "string" },
        port: { type: "string", short: "p" },
        "no-open-browser": { type: "boolean" },
        restart: { type: "boolean" },
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

  const file = loadConfigFile();
  const host = values.host || file.host || "0.0.0.0";
  const port = parseInt(values.port || String(file.port || 3456), 10);

  return {
    host,
    port,
    chatApiUrl: `http://${host === "0.0.0.0" ? "localhost" : host}:${port}`,
    openBrowser: !values["no-open-browser"],
    projectRoot: process.cwd(),
    debug: values.debug || file.debug || false,
    yolo: values.yolo || file.yolo || false,
    contextMode: true,
    heartbeat: file.heartbeat,
  };
}

/** Validate configuration */
export function validateConfig(_config: AppConfig): boolean {
  return true; // Agent runs in-process, no external binary to validate
}

function printUsage() {
  console.log(`Claw'd App

Usage: clawd-app [options]

Options:
  --host <host>               Server host (default: 0.0.0.0)
  -p, --port <port>           Server port (default: 3456)
  --no-open-browser            Don't open browser on startup
  --restart                    Auto-restart on crash or SIGTERM
  --yolo                       Disable sandbox restrictions for agents
  --debug                      Enable debug logging
  -h, --help                  Show this help message

  Settings can also be configured in ~/.clawd/config.json:
    { "host": "0.0.0.0", "port": 3456, "debug": false }
  CLI flags take precedence over config file values.

Examples:
  clawd-app
  clawd-app --host localhost --port 8080
  clawd-app --no-open-browser --debug
  clawd-app --restart
`);
}
