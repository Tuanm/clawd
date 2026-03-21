// CSV/JSON parsers and filter engine for artifact datasource endpoint.

const MAX_ROWS = 10_000;

// ── Types ────────────────────────────────────────────────────────────────────

export interface FilterOps {
  eq?: string | number;
  neq?: string | number;
  gt?: number;
  gte?: number;
  lt?: number;
  lte?: number;
  contains?: string;
  in?: (string | number)[];
}

export interface SortSpec {
  field: string;
  order?: "asc" | "desc";
}

export interface ParsedData {
  columns: string[];
  rows: Record<string, string>[];
}

// ── CSV Parser ───────────────────────────────────────────────────────────────

function parseCsvRow(line: string, delimiter: string): string[] {
  const cells: string[] = [];
  let cell = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (i + 1 < line.length && line[i + 1] === '"') {
          cell += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        cell += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === delimiter) {
      cells.push(cell.trim());
      cell = "";
    } else {
      cell += ch;
    }
  }
  cells.push(cell.trim());
  return cells;
}

export function parseCsvToRows(text: string, delimiter: string): ParsedData {
  const lines = text
    .replace(/\r\n/g, "\n")
    .split("\n")
    .filter((l) => l.trim());
  if (lines.length === 0) return { columns: [], rows: [] };
  const columns = parseCsvRow(lines[0], delimiter);
  const rows: Record<string, string>[] = [];
  for (let i = 1; i < lines.length && rows.length < MAX_ROWS; i++) {
    const cells = parseCsvRow(lines[i], delimiter);
    const row: Record<string, string> = {};
    for (let j = 0; j < columns.length; j++) {
      row[columns[j]] = cells[j] ?? "";
    }
    rows.push(row);
  }
  return { columns, rows };
}

// ── JSON Parser ──────────────────────────────────────────────────────────────

export function parseJsonToRows(text: string): ParsedData {
  const parsed = JSON.parse(text);
  const arr = Array.isArray(parsed) ? parsed : parsed?.data;
  if (!Array.isArray(arr)) throw new Error("JSON must be array or {data:[]}");
  const limited = arr.slice(0, MAX_ROWS);
  const columns = limited.length > 0 ? Object.keys(limited[0]) : [];
  const rows = limited.map((item: Record<string, unknown>) => {
    const row: Record<string, string> = {};
    for (const k of columns) row[k] = String(item[k] ?? "");
    return row;
  });
  return { columns, rows };
}

// ── Filter Engine ────────────────────────────────────────────────────────────

export function applyFilters(
  rows: Record<string, string>[],
  filters: Record<string, FilterOps>,
): Record<string, string>[] {
  if (!filters || Object.keys(filters).length === 0) return rows;
  return rows.filter((row) => {
    for (const [field, ops] of Object.entries(filters)) {
      const val = row[field];
      if (val == null) return false;
      if (ops.eq != null && ops.eq !== "" && String(val) !== String(ops.eq)) return false;
      if (ops.neq != null && ops.neq !== "" && String(val) === String(ops.neq)) return false;
      if (ops.gt != null && Number(val) <= Number(ops.gt)) return false;
      if (ops.gte != null && Number(val) < Number(ops.gte)) return false;
      if (ops.lt != null && Number(val) >= Number(ops.lt)) return false;
      if (ops.lte != null && Number(val) > Number(ops.lte)) return false;
      if (
        ops.contains != null &&
        ops.contains !== "" &&
        !String(val).toLowerCase().includes(String(ops.contains).toLowerCase())
      )
        return false;
      if (
        ops.in != null &&
        Array.isArray(ops.in) &&
        ops.in.length > 0 &&
        !ops.in.some((v) => String(v) === String(val))
      )
        return false;
    }
    return true;
  });
}

// ── Sort & Limit ─────────────────────────────────────────────────────────────

export function applySortAndLimit(
  rows: Record<string, string>[],
  sort?: SortSpec,
  limit?: number,
): Record<string, string>[] {
  let result = rows;
  if (sort?.field) {
    result = [...result].sort((a, b) => {
      const av = a[sort.field] ?? "";
      const bv = b[sort.field] ?? "";
      const an = Number(av);
      const bn = Number(bv);
      const cmp = !Number.isNaN(an) && !Number.isNaN(bn) ? an - bn : String(av).localeCompare(String(bv));
      return sort.order === "desc" ? -cmp : cmp;
    });
  }
  if (limit && limit > 0) result = result.slice(0, Math.min(limit, MAX_ROWS));
  return result;
}
