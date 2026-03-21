import { existsSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { ATTACHMENTS_DIR, db } from "../database";
import {
  type FilterOps,
  type ParsedData,
  type SortSpec,
  applyFilters,
  applySortAndLimit,
  parseCsvToRows,
  parseJsonToRows,
} from "./datasource-parsers";

const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB
const MAX_ROWS = 10_000;
const CACHE_TTL_MS = 60_000;
const MAX_CACHE = 100;

// ── Types ────────────────────────────────────────────────────────────────────

interface DatasourceRequest {
  file_id?: string;
  file_name?: string;
  filters?: Record<string, FilterOps>;
  sort?: SortSpec;
  limit?: number;
}

interface DatasourceResult {
  ok: true;
  data: Record<string, string>[];
  columns: string[];
  total: number;
  filtered: number;
  truncated: boolean;
}

interface DatasourceError {
  ok: false;
  error: string;
  message?: string;
}

// ── Cache ────────────────────────────────────────────────────────────────────

interface CacheEntry extends ParsedData {
  cachedAt: number;
}

const dataCache = new Map<string, CacheEntry>();

function getCached(fileId: string, mtime: number): CacheEntry | null {
  const key = `${fileId}:${mtime}`;
  const entry = dataCache.get(key);
  if (entry && Date.now() - entry.cachedAt < CACHE_TTL_MS) return entry;
  if (entry) dataCache.delete(key);
  return null;
}

function setCache(fileId: string, mtime: number, data: CacheEntry): void {
  const key = `${fileId}:${mtime}`;
  if (dataCache.size >= MAX_CACHE) {
    const oldest = dataCache.keys().next().value;
    if (oldest) dataCache.delete(oldest);
  }
  dataCache.set(key, data);
}

// ── Main Handler ─────────────────────────────────────────────────────────────

export function handleDatasource(req: DatasourceRequest): DatasourceResult | DatasourceError {
  // Resolve file
  let file: { id: string; path: string; name: string; size: number } | undefined;
  if (req.file_id) {
    file = db.query<any, [string]>("SELECT id, path, name, size FROM files WHERE id = ?").get(req.file_id);
  } else if (req.file_name) {
    file = db
      .query<any, [string]>("SELECT id, path, name, size FROM files WHERE name = ? ORDER BY created_at DESC LIMIT 1")
      .get(req.file_name);
  }
  if (!file) return { ok: false, error: "file_not_found" };

  // Path containment check
  const resolved = resolve(file.path);
  if (!resolved.startsWith(resolve(ATTACHMENTS_DIR))) {
    return { ok: false, error: "file_not_found" };
  }

  // Size check before read
  if (file.size > MAX_FILE_SIZE) {
    return { ok: false, error: "file_too_large" };
  }

  if (!existsSync(resolved)) {
    return { ok: false, error: "file_not_found" };
  }

  // Detect format
  const ext = file.name.split(".").pop()?.toLowerCase() ?? "";
  if (!["csv", "tsv", "json"].includes(ext)) {
    return { ok: false, error: "unsupported_format" };
  }

  // Check cache
  const mtime = statSync(resolved).mtimeMs;
  let parsed = getCached(file.id, mtime);

  if (!parsed) {
    try {
      const text = readFileSync(resolved, "utf-8");
      const result = ext === "json" ? parseJsonToRows(text) : parseCsvToRows(text, ext === "tsv" ? "\t" : ",");
      parsed = { ...result, cachedAt: Date.now() };
      setCache(file.id, mtime, parsed);
    } catch {
      return { ok: false, error: "parse_error", message: "Failed to parse file" };
    }
  }

  const total = parsed.rows.length;
  const truncatedAtParse = total >= MAX_ROWS;

  // Apply filters
  let filtered: Record<string, string>[];
  try {
    filtered = applyFilters(parsed.rows, req.filters ?? {});
  } catch {
    return { ok: false, error: "invalid_filters" };
  }

  // Sort + limit
  const result = applySortAndLimit(filtered, req.sort, req.limit);

  return {
    ok: true,
    data: result,
    columns: parsed.columns,
    total,
    filtered: filtered.length,
    truncated: truncatedAtParse,
  };
}
