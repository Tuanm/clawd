/**
 * Schedule Parser — parses schedule expressions into typed schedule objects
 *
 * Supported formats (first match wins):
 * 1. ISO 8601: "2024-03-15T14:00:00Z" → once
 * 2. 5-part cron: "0 9 * * *" → cron (all times UTC)
 * 3. Relative: "in 30 minutes", "in 2 hours", "in 3 days" → once
 * 4. Interval: "every 5 minutes", "every 2 hours", "every day" → interval
 */

export type ParsedSchedule =
  | { type: "once"; run_at: number; next_run: number }
  | { type: "interval"; interval_ms: number; next_run: number }
  | { type: "cron"; cron_expr: string; next_run: number };

export type ParseResult = { success: true; schedule: ParsedSchedule } | { success: false; error: string };

const USAGE_HINT = 'Use: "in 5 minutes", "every 2 hours", cron "0 9 * * *", or ISO 8601 "2024-12-25T10:00:00Z"';

const MIN_INTERVAL_MS = 60_000; // 1 minute
const MIN_ONCE_DELAY_MS = 10_000; // 10 seconds
const MAX_ONCE_DELAY_MS = 365 * 24 * 60 * 60 * 1000; // 365 days

const TIME_UNITS: Record<string, number> = {
  second: 1000,
  seconds: 1000,
  sec: 1000,
  secs: 1000,
  s: 1000,
  minute: 60_000,
  minutes: 60_000,
  min: 60_000,
  mins: 60_000,
  m: 60_000,
  hour: 3_600_000,
  hours: 3_600_000,
  hr: 3_600_000,
  hrs: 3_600_000,
  h: 3_600_000,
  day: 86_400_000,
  days: 86_400_000,
  d: 86_400_000,
  week: 604_800_000,
  weeks: 604_800_000,
  w: 604_800_000,
};

export function parseSchedule(input: string): ParseResult {
  const trimmed = input.trim();
  if (!trimmed) return { success: false, error: `Empty schedule expression. ${USAGE_HINT}` };

  // 1. ISO 8601
  const iso = tryParseISO(trimmed);
  if (iso) return iso;

  // 2. 5-part cron
  const cron = tryParseCron(trimmed);
  if (cron) return cron;

  // 3. Relative "in X unit"
  const relative = tryParseRelative(trimmed);
  if (relative) return relative;

  // 4. Interval "every X unit"
  const interval = tryParseInterval(trimmed);
  if (interval) return interval;

  return { success: false, error: `Invalid schedule: "${trimmed}". ${USAGE_HINT}` };
}

function tryParseISO(input: string): ParseResult | null {
  // Quick check: must contain 'T' and look like a date
  if (!/^\d{4}-\d{2}-\d{2}T/.test(input)) return null;

  const ts = new Date(input).getTime();
  if (isNaN(ts)) return { success: false, error: `Invalid ISO 8601 date: "${input}"` };

  const now = Date.now();
  if (ts <= now) return { success: false, error: "Schedule time must be in the future" };
  if (ts - now > MAX_ONCE_DELAY_MS) return { success: false, error: "Schedule time must be within 365 days" };

  return { success: true, schedule: { type: "once", run_at: ts, next_run: ts } };
}

function tryParseCron(input: string): ParseResult | null {
  const parts = input.split(/\s+/);
  if (parts.length !== 5) return null;

  // Validate each field
  const ranges = [
    { min: 0, max: 59, name: "minute" },
    { min: 0, max: 23, name: "hour" },
    { min: 1, max: 31, name: "day" },
    { min: 1, max: 12, name: "month" },
    { min: 0, max: 7, name: "weekday" }, // 0 and 7 = Sunday
  ];

  for (let i = 0; i < 5; i++) {
    if (!isValidCronField(parts[i], ranges[i].min, ranges[i].max)) {
      return { success: false, error: `Invalid cron ${ranges[i].name} field: "${parts[i]}"` };
    }
  }

  const nextRun = calculateNextCronRun(parts);
  if (nextRun === null) {
    return { success: false, error: "Could not calculate next cron run time" };
  }

  return { success: true, schedule: { type: "cron", cron_expr: input, next_run: nextRun } };
}

function isValidCronField(field: string, min: number, max: number): boolean {
  // Supports: *, */N, N, N-M, N,M,L
  if (field === "*") return true;
  if (/^\*\/\d+$/.test(field)) {
    const step = parseInt(field.slice(2));
    return step > 0 && step <= max;
  }
  // Comma-separated values or ranges
  const parts = field.split(",");
  for (const part of parts) {
    if (/^\d+-\d+$/.test(part)) {
      const [a, b] = part.split("-").map(Number);
      if (a < min || b > max || a > b) return false;
    } else if (/^\d+$/.test(part)) {
      const n = parseInt(part);
      if (n < min || n > max) return false;
    } else {
      return false;
    }
  }
  return true;
}

/** Calculate next cron run from now (UTC) */
export function calculateNextCronRun(parts: string[]): number | null {
  const now = new Date();
  // Start from next minute
  const candidate = new Date(now);
  candidate.setUTCSeconds(0, 0);
  candidate.setUTCMinutes(candidate.getUTCMinutes() + 1);

  // Search up to 2 years ahead
  const maxIterations = 365 * 24 * 60 * 2;
  for (let i = 0; i < maxIterations; i++) {
    if (cronMatches(parts, candidate)) {
      return candidate.getTime();
    }
    candidate.setUTCMinutes(candidate.getUTCMinutes() + 1);
  }
  return null;
}

function cronMatches(parts: string[], date: Date): boolean {
  const minute = date.getUTCMinutes();
  const hour = date.getUTCHours();
  const day = date.getUTCDate();
  const month = date.getUTCMonth() + 1; // 1-based
  const weekday = date.getUTCDay(); // 0=Sun

  return (
    fieldMatches(parts[0], minute, 0) &&
    fieldMatches(parts[1], hour, 0) &&
    fieldMatches(parts[2], day, 1) &&
    fieldMatches(parts[3], month, 1) &&
    fieldMatches(parts[4], weekday, 0, true)
  );
}

function fieldMatches(field: string, value: number, min: number, isWeekday = false): boolean {
  if (field === "*") return true;
  if (field.startsWith("*/")) {
    const step = parseInt(field.slice(2));
    return (value - min) % step === 0;
  }
  const parts = field.split(",");
  for (const part of parts) {
    if (part.includes("-")) {
      const [a, b] = part.split("-").map(Number);
      if (value >= a && value <= b) return true;
      // Weekday range: if upper bound is 7, also match Sunday (0)
      if (isWeekday && b === 7 && value === 0 && a <= 7) return true;
    } else {
      const n = parseInt(part);
      // Handle weekday 7 = Sunday (same as 0) — only for weekday field
      if (n === value || (isWeekday && n === 7 && value === 0)) return true;
    }
  }
  return false;
}

function tryParseRelative(input: string): ParseResult | null {
  const match = input.match(/^in\s+(\d+)\s+(\w+)$/i);
  if (!match) return null;

  const amount = parseInt(match[1]);
  const unit = match[2].toLowerCase();

  const ms = TIME_UNITS[unit];
  if (!ms) return { success: false, error: `Unknown time unit: "${match[2]}". Use minutes, hours, days, or weeks.` };

  const delayMs = amount * ms;
  if (delayMs < MIN_ONCE_DELAY_MS) return { success: false, error: "Minimum delay is 10 seconds" };
  if (delayMs > MAX_ONCE_DELAY_MS) return { success: false, error: "Maximum delay is 365 days" };

  const runAt = Date.now() + delayMs;
  return { success: true, schedule: { type: "once", run_at: runAt, next_run: runAt } };
}

function tryParseInterval(input: string): ParseResult | null {
  // "every day" / "every hour" / "every minute"
  const simpleMatch = input.match(/^every\s+(minute|hour|day|week)$/i);
  if (simpleMatch) {
    const unit = simpleMatch[1].toLowerCase();
    const ms = TIME_UNITS[unit]!;
    if (ms < MIN_INTERVAL_MS) return { success: false, error: "Minimum interval is 1 minute" };
    return { success: true, schedule: { type: "interval", interval_ms: ms, next_run: Date.now() + ms } };
  }

  // "every N unit"
  const match = input.match(/^every\s+(\d+)\s+(\w+)$/i);
  if (!match) return null;

  const amount = parseInt(match[1]);
  const unit = match[2].toLowerCase();

  const ms = TIME_UNITS[unit];
  if (!ms) return { success: false, error: `Unknown time unit: "${match[2]}". Use minutes, hours, days, or weeks.` };

  const intervalMs = amount * ms;
  if (intervalMs < MIN_INTERVAL_MS) return { success: false, error: "Minimum interval is 1 minute" };

  return {
    success: true,
    schedule: { type: "interval", interval_ms: intervalMs, next_run: Date.now() + intervalMs },
  };
}
