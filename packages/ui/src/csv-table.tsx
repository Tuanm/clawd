import { useMemo, useState } from "react";

interface CsvTableProps {
  content: string;
  maxRows?: number;
}

function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  for (const line of lines) {
    if (!line.trim()) continue;
    const cells: string[] = [];
    let current = "";
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (inQuotes) {
        if (ch === '"' && line[i + 1] === '"') {
          current += '"';
          i++;
        } else if (ch === '"') {
          inQuotes = false;
        } else {
          current += ch;
        }
      } else {
        if (ch === '"') {
          inQuotes = true;
        } else if (ch === ",") {
          cells.push(current.trim());
          current = "";
        } else {
          current += ch;
        }
      }
    }
    cells.push(current.trim());
    rows.push(cells);
  }
  return rows;
}

type SortDir = "asc" | "desc" | null;

export default function CsvTable({ content, maxRows = 100 }: CsvTableProps) {
  const rows = useMemo(() => parseCsv(content), [content]);
  const [showAll, setShowAll] = useState(false);
  const [sortCol, setSortCol] = useState<number | null>(null);
  const [sortDir, setSortDir] = useState<SortDir>(null);

  if (rows.length === 0) {
    return <div className="artifact-csv-empty">No data</div>;
  }

  const headers = rows[0];
  const dataRows = rows.slice(1);

  const sortedRows = useMemo(() => {
    if (sortCol === null || sortDir === null) return dataRows;
    return [...dataRows].sort((a, b) => {
      const av = a[sortCol] ?? "";
      const bv = b[sortCol] ?? "";
      const numA = parseFloat(av);
      const numB = parseFloat(bv);
      const isNum = !isNaN(numA) && !isNaN(numB);
      const cmp = isNum ? numA - numB : av.localeCompare(bv);
      return sortDir === "asc" ? cmp : -cmp;
    });
  }, [dataRows, sortCol, sortDir]);

  const displayRows = showAll ? sortedRows : sortedRows.slice(0, maxRows);
  const truncated = sortedRows.length > maxRows && !showAll;

  function handleHeaderClick(colIdx: number) {
    if (sortCol !== colIdx) {
      setSortCol(colIdx);
      setSortDir("asc");
    } else if (sortDir === "asc") {
      setSortDir("desc");
    } else {
      setSortCol(null);
      setSortDir(null);
    }
  }

  return (
    <div className="artifact-csv-table">
      <table>
        <thead>
          <tr>
            {headers.map((h, i) => (
              <th
                key={i}
                onClick={() => handleHeaderClick(i)}
                className={sortCol === i ? `sorted-${sortDir}` : ""}
                title="Click to sort"
              >
                {h}
                {sortCol === i && sortDir === "asc" && " ▲"}
                {sortCol === i && sortDir === "desc" && " ▼"}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {displayRows.map((row, ri) => (
            <tr key={ri} className={ri % 2 === 0 ? "row-even" : "row-odd"}>
              {row.map((cell, ci) => (
                <td key={ci}>{cell}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {truncated && (
        <div className="artifact-csv-truncated">
          Showing {maxRows} of {sortedRows.length} rows
          <button className="artifact-csv-show-all" onClick={() => setShowAll(true)}>
            Show all {sortedRows.length} rows
          </button>
        </div>
      )}
    </div>
  );
}
