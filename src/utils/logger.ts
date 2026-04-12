/**
 * Lightweight logger utility — no external dependencies.
 * Supports log levels, component tagging, and ISO timestamps.
 */

type LogLevel = "debug" | "info" | "warn" | "error";

const LEVELS: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };
let minLevel: LogLevel = "info";

export function setLogLevel(level: LogLevel): void {
  minLevel = level;
}

export function getLogLevel(): LogLevel {
  return minLevel;
}

function log(level: LogLevel, component: string, message: string, ...args: unknown[]): void {
  if (LEVELS[level] < LEVELS[minLevel]) return;
  const timestamp = new Date().toISOString();
  const tag = `[${timestamp}] [${level.toUpperCase()}] [${component}]`;
  const fn = level === "error" ? console.error : level === "warn" ? console.warn : console.log;
  fn(tag, message, ...args);
}

export function createLogger(component: string) {
  return {
    debug: (msg: string, ...args: unknown[]) => log("debug", component, msg, ...args),
    info: (msg: string, ...args: unknown[]) => log("info", component, msg, ...args),
    warn: (msg: string, ...args: unknown[]) => log("warn", component, msg, ...args),
    error: (msg: string, ...args: unknown[]) => log("error", component, msg, ...args),
  };
}
