import { useEffect, useMemo, useRef, useState } from "react";
import { authFetch } from "./auth-fetch";

interface Datasource {
  type: string;
  file_id?: string;
  file_name?: string;
  filters?: Record<string, Record<string, unknown>>;
  sort?: { field: string; order?: string };
  limit?: number;
}

export interface DatasourceResult {
  data: Record<string, unknown>[] | null;
  columns: string[];
  loading: boolean;
  error: string | null;
  truncated: boolean;
}

function extractRefs(filters?: Record<string, Record<string, unknown>>): string[] {
  if (!filters) return [];
  const refs: string[] = [];
  for (const ops of Object.values(filters)) {
    for (const val of Object.values(ops)) {
      if (typeof val === "string" && val.startsWith("{{") && val.endsWith("}}")) {
        refs.push(val.slice(2, -2));
      }
    }
  }
  return [...new Set(refs)];
}

function resolveFilters(
  filters: Record<string, Record<string, unknown>>,
  values: Record<string, unknown>,
): Record<string, Record<string, unknown>> {
  const resolved: Record<string, Record<string, unknown>> = {};
  for (const [field, ops] of Object.entries(filters)) {
    const resolvedOps: Record<string, unknown> = {};
    for (const [op, val] of Object.entries(ops)) {
      if (typeof val === "string" && val.startsWith("{{") && val.endsWith("}}")) {
        const refValue = values[val.slice(2, -2)];
        if (refValue == null || refValue === "") continue;
        resolvedOps[op] = refValue;
      } else {
        resolvedOps[op] = val;
      }
    }
    if (Object.keys(resolvedOps).length > 0) resolved[field] = resolvedOps;
  }
  return resolved;
}

export function useDatasource(datasource: Datasource | undefined, values: Record<string, unknown>): DatasourceResult {
  const [result, setResult] = useState<DatasourceResult>({
    data: null,
    columns: [],
    loading: false,
    error: null,
    truncated: false,
  });

  // Cache last successful response to prevent flash during re-fetch
  const cache = useRef<{ data: Record<string, unknown>[]; columns: string[]; truncated: boolean } | null>(null);

  const refIds = useMemo(() => extractRefs(datasource?.filters), [datasource]);

  // Only track values referenced in filters — prevents unrelated state changes triggering re-fetch
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const refValues = useMemo(() => {
    const rv: Record<string, unknown> = {};
    for (const id of refIds) rv[id] = values[id];
    return rv;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refIds, ...refIds.map((id) => values[id])]);

  useEffect(() => {
    if (!datasource) return;

    const controller = new AbortController();

    const timer = setTimeout(async () => {
      // Show loading but keep previous data visible
      setResult((prev) => ({ ...prev, loading: true, error: null }));

      const resolvedFilters = datasource.filters ? resolveFilters(datasource.filters, refValues) : undefined;

      try {
        const res = await authFetch("/api/artifact.datasource", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            type: datasource.type,
            file_id: datasource.file_id,
            file_name: datasource.file_name,
            filters: resolvedFilters,
            sort: datasource.sort,
            limit: datasource.limit,
          }),
          signal: controller.signal,
        });

        if (!res.ok) {
          const msg = await res.text().catch(() => "Request failed");
          setResult((prev) => ({ ...prev, loading: false, error: msg }));
          return;
        }

        const json = await res.json();
        cache.current = { data: json.data, columns: json.columns, truncated: json.truncated ?? false };
        setResult({
          data: json.data,
          columns: json.columns,
          loading: false,
          error: null,
          truncated: json.truncated ?? false,
        });
      } catch (e) {
        if ((e as Error).name === "AbortError") return;
        setResult((prev) => ({
          ...prev,
          loading: false,
          error: e instanceof Error ? e.message : "Network error",
        }));
      }
    }, 300);

    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [datasource, refValues]);

  // While loading, surface cached data so chart/table don't flash empty
  if (result.loading && cache.current) {
    return { ...cache.current, loading: true, error: null };
  }

  return result;
}
