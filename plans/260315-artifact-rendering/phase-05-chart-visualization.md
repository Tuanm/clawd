# Phase 5: Chart & Data Visualization (P2)

## Context Links
- [artifact-renderer.tsx](./phase-03-artifact-detection-panel.md) — chart case placeholder from Phase 3
- [package.json](../../packages/ui/package.json) — current dependencies
- [styles.css](../../packages/ui/src/styles.css) — theme variables

## Overview
- **Priority:** P2
- **Status:** Complete
- **Depends on:** Phase 3 (Artifact Detection)
- **Description:** Integrate Recharts for rendering chart-type artifacts. Agents output JSON chart specifications; the UI renders interactive charts with tooltips, legends, and responsive sizing.

## Key Insights
- Recharts is ~50KB gzipped, built on D3 + React — matches the React 18 stack
- Chart artifacts use JSON spec format — agent outputs `<artifact type="chart" title="...">{ JSON }</artifact>`
- Recharts supports: LineChart, BarChart, PieChart, AreaChart, ScatterChart, ComposedChart
- Interactive features (tooltips, zoom) work out of the box
- Dark/light theme: Recharts accepts color props — pass CSS variable values via JS

## Requirements

### Functional
- Render chart artifacts from JSON specification
- Support chart types: line, bar, pie, area, scatter, composed
- Interactive: hover tooltips with data values
- Responsive: chart fills artifact card width
- Legend with toggleable series
- Axis labels and grid lines

### Non-Functional
- Recharts lazy-loaded — not in initial bundle
- Chart renders in < 100ms for typical datasets (< 1000 points)
- Graceful fallback for malformed JSON (show error + raw JSON)

## Architecture

### Chart JSON Specification

```json
{
  "type": "line",
  "title": "Monthly Revenue",
  "xAxis": { "dataKey": "month", "label": "Month" },
  "yAxis": { "label": "Revenue ($)" },
  "data": [
    { "month": "Jan", "revenue": 4000, "profit": 2400 },
    { "month": "Feb", "revenue": 3000, "profit": 1398 }
  ],
  "series": [
    { "dataKey": "revenue", "color": "#8884d8", "name": "Revenue" },
    { "dataKey": "profit", "color": "#82ca9d", "name": "Profit" }
  ]
}
```

| Field | Required | Description |
|-------|----------|-------------|
| `type` | Yes | `line`, `bar`, `pie`, `area`, `scatter`, `composed` |
| `data` | Yes | Array of data objects |
| `series` | Yes (except pie) | Array of `{ dataKey, color?, name? }` |
| `xAxis` | No | `{ dataKey, label? }` |
| `yAxis` | No | `{ label? }` |
| `title` | No | Chart title (overrides artifact title) |

For pie charts:
```json
{
  "type": "pie",
  "data": [
    { "name": "Group A", "value": 400 },
    { "name": "Group B", "value": 300 }
  ],
  "dataKey": "value",
  "nameKey": "name"
}
```

### Component Structure

```
ArtifactRenderer (type="chart")
  |
  v
ChartRenderer (lazy loaded)
  |
  ├── parseChartSpec(content) ──> validated spec or error
  |
  ├── type="line"    → <ResponsiveContainer><LineChart ...>
  ├── type="bar"     → <ResponsiveContainer><BarChart ...>
  ├── type="pie"     → <ResponsiveContainer><PieChart ...>
  ├── type="area"    → <ResponsiveContainer><AreaChart ...>
  ├── type="scatter" → <ResponsiveContainer><ScatterChart ...>
  └── type="composed"→ <ResponsiveContainer><ComposedChart ...>
```

## Related Code Files

### Files to Modify
| File | Changes |
|------|---------|
| `packages/ui/src/artifact-renderer.tsx` | Replace chart placeholder with lazy-loaded ChartRenderer |
| `packages/ui/package.json` | Add `recharts` dependency |
| `packages/ui/src/styles.css` | Add `.artifact-chart` styles |

### Files to Create
| File | Purpose |
|------|---------|
| `packages/ui/src/chart-renderer.tsx` | ChartRenderer component with all chart types |

## Implementation Steps

### Step 1: Install Recharts

```bash
cd packages/ui && bun add recharts
```

### Step 2: Create chart-renderer.tsx (~150 lines)

```typescript
// packages/ui/src/chart-renderer.tsx
import React, { useMemo } from "react";
import {
  LineChart, Line, BarChart, Bar, PieChart, Pie, Cell,
  AreaChart, Area, ScatterChart, Scatter,
  ComposedChart,
  XAxis, YAxis, CartesianGrid, Tooltip, Legend,
  ResponsiveContainer,
} from "recharts";

interface ChartSeries {
  dataKey: string;
  color?: string;
  name?: string;
  type?: "line" | "bar" | "area";  // for composed charts
}

interface ChartSpec {
  type: "line" | "bar" | "pie" | "area" | "scatter" | "composed";
  data: Record<string, unknown>[];
  series?: ChartSeries[];
  xAxis?: { dataKey?: string; label?: string };
  yAxis?: { label?: string };
  title?: string;
  // Pie-specific
  dataKey?: string;
  nameKey?: string;
}

const DEFAULT_COLORS = [
  "#8884d8", "#82ca9d", "#ffc658", "#ff7c7c", "#8dd1e1",
  "#a4de6c", "#d0ed57", "#ffa07a", "#dda0dd", "#87ceeb",
];

function parseChartSpec(content: string): ChartSpec {
  const spec = JSON.parse(content);
  if (!spec.type || !Array.isArray(spec.data)) {
    throw new Error("Chart spec requires 'type' and 'data' array");
  }
  return spec as ChartSpec;
}

export default function ChartRenderer({ content }: { content: string }) {
  const result = useMemo(() => {
    try {
      return { spec: parseChartSpec(content), error: null };
    } catch (e: any) {
      return { spec: null, error: e.message };
    }
  }, [content]);

  if (result.error || !result.spec) {
    return (
      <div className="artifact-chart-error">
        <p>Failed to parse chart: {result.error}</p>
        <details>
          <summary>Raw JSON</summary>
          <pre>{content}</pre>
        </details>
      </div>
    );
  }

  const { spec } = result;
  const series = spec.series ?? [];
  const xDataKey = spec.xAxis?.dataKey ?? "name";

  return (
    <div className="artifact-chart">
      {spec.title && <div className="artifact-chart-title">{spec.title}</div>}
      <ResponsiveContainer width="100%" height={350}>
        {renderChart(spec, series, xDataKey)}
      </ResponsiveContainer>
    </div>
  );
}

function renderChart(spec: ChartSpec, series: ChartSeries[], xDataKey: string) {
  const grid = <CartesianGrid strokeDasharray="3 3" />;
  const xAxis = <XAxis dataKey={xDataKey} label={spec.xAxis?.label ? { value: spec.xAxis.label, position: "insideBottom", offset: -5 } : undefined} />;
  const yAxis = <YAxis label={spec.yAxis?.label ? { value: spec.yAxis.label, angle: -90, position: "insideLeft" } : undefined} />;
  const tooltip = <Tooltip />;
  const legend = <Legend />;

  switch (spec.type) {
    case "line":
      return (
        <LineChart data={spec.data}>
          {grid}{xAxis}{yAxis}{tooltip}{legend}
          {series.map((s, i) => (
            <Line key={s.dataKey} type="monotone" dataKey={s.dataKey} stroke={s.color || DEFAULT_COLORS[i % DEFAULT_COLORS.length]} name={s.name || s.dataKey} />
          ))}
        </LineChart>
      );

    case "bar":
      return (
        <BarChart data={spec.data}>
          {grid}{xAxis}{yAxis}{tooltip}{legend}
          {series.map((s, i) => (
            <Bar key={s.dataKey} dataKey={s.dataKey} fill={s.color || DEFAULT_COLORS[i % DEFAULT_COLORS.length]} name={s.name || s.dataKey} />
          ))}
        </BarChart>
      );

    case "area":
      return (
        <AreaChart data={spec.data}>
          {grid}{xAxis}{yAxis}{tooltip}{legend}
          {series.map((s, i) => (
            <Area key={s.dataKey} type="monotone" dataKey={s.dataKey} stroke={s.color || DEFAULT_COLORS[i % DEFAULT_COLORS.length]} fill={s.color || DEFAULT_COLORS[i % DEFAULT_COLORS.length]} fillOpacity={0.3} name={s.name || s.dataKey} />
          ))}
        </AreaChart>
      );

    case "scatter":
      return (
        <ScatterChart>
          {grid}{xAxis}{yAxis}{tooltip}{legend}
          {series.map((s, i) => (
            <Scatter key={s.dataKey} data={spec.data} dataKey={s.dataKey} fill={s.color || DEFAULT_COLORS[i % DEFAULT_COLORS.length]} name={s.name || s.dataKey} />
          ))}
        </ScatterChart>
      );

    case "pie":
      return (
        <PieChart>
          <Pie data={spec.data} dataKey={spec.dataKey || "value"} nameKey={spec.nameKey || "name"} cx="50%" cy="50%" outerRadius={120} label>
            {spec.data.map((_, i) => (
              <Cell key={`cell-${i}`} fill={DEFAULT_COLORS[i % DEFAULT_COLORS.length]} />
            ))}
          </Pie>
          {tooltip}{legend}
        </PieChart>
      );

    case "composed":
      return (
        <ComposedChart data={spec.data}>
          {grid}{xAxis}{yAxis}{tooltip}{legend}
          {series.map((s, i) => {
            const color = s.color || DEFAULT_COLORS[i % DEFAULT_COLORS.length];
            const name = s.name || s.dataKey;
            switch (s.type) {
              case "bar": return <Bar key={s.dataKey} dataKey={s.dataKey} fill={color} name={name} />;
              case "area": return <Area key={s.dataKey} type="monotone" dataKey={s.dataKey} stroke={color} fill={color} fillOpacity={0.3} name={name} />;
              default: return <Line key={s.dataKey} type="monotone" dataKey={s.dataKey} stroke={color} name={name} />;
            }
          })}
        </ComposedChart>
      );

    default:
      return <div>Unsupported chart type: {spec.type}</div>;
  }
}
```

### Step 3: Update artifact-renderer.tsx — lazy load ChartRenderer

```typescript
// Add at top of artifact-renderer.tsx:
const ChartRenderer = React.lazy(() => import("./chart-renderer"));

// Replace chart case:
case "chart":
  return (
    <React.Suspense fallback={<div className="artifact-renderer-placeholder">Loading chart...</div>}>
      <ChartRenderer content={content} />
    </React.Suspense>
  );
```

### Step 4: Add CSS styles

```css
/* ── Chart artifacts ───────────────────────────────────────────── */
.artifact-chart {
  padding: 12px 0;
}

.artifact-chart-title {
  font-weight: 600;
  font-size: 14px;
  text-align: center;
  margin-bottom: 8px;
}

.artifact-chart-error {
  padding: 12px;
  color: var(--text-secondary, #586069);
}

.artifact-chart-error pre {
  margin-top: 8px;
  font-size: 12px;
  max-height: 200px;
  overflow: auto;
}

/* Recharts tooltip dark mode */
@media (prefers-color-scheme: dark) {
  .recharts-default-tooltip {
    background-color: #1c2128 !important;
    border-color: #30363d !important;
  }
  .recharts-cartesian-grid line {
    stroke: #30363d;
  }
  .recharts-text {
    fill: #8b949e;
  }
}
```

## Todo List

- [x] Install `recharts` dependency
- [x] Create `chart-renderer.tsx` with all chart type renderers
- [x] Define and document chart JSON specification format
- [x] Update `artifact-renderer.tsx` with lazy-loaded chart case
- [x] Add chart CSS styles with dark mode support
- [ ] Test: Line chart with multiple series renders correctly
- [ ] Test: Bar chart with custom colors
- [ ] Test: Pie chart with labels
- [ ] Test: Area chart with fill opacity
- [ ] Test: Composed chart with mixed series types
- [ ] Test: Malformed JSON shows error with raw data fallback
- [ ] Test: Chart is responsive (resizes with container)
- [ ] Test: Tooltip shows data on hover
- [ ] Test: Dark mode chart styling
- [ ] Run `bun run build:ui` to verify no compile errors

## Success Criteria
- All 6 chart types render from JSON spec
- Charts are interactive (tooltips, legends)
- Responsive sizing within artifact card
- Malformed JSON shows helpful error message
- Recharts is lazy-loaded (not in initial bundle)
- Dark mode compatible

## Risk Assessment

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Recharts adds ~50KB to bundle | Certain | Low | Lazy-loaded via React.lazy — only loaded when chart artifact encountered |
| Large datasets (>10K points) cause slow renders | Low | Medium | Add data point limit (truncate with warning if > 5000 points) |
| Agent outputs invalid JSON | Medium | Low | parseChartSpec validates and shows error with raw JSON fallback |
| Recharts tooltip positioning broken in scrollable artifact card | Low | Low | Test; if issue, set Tooltip `wrapperStyle` with fixed positioning |

## Security Considerations
- Chart data is JSON-parsed — no HTML injection vector
- Recharts renders SVG — no script execution
- JSON.parse throws on invalid input — caught by error boundary

## Next Steps
- Consider adding chart export (download as PNG/SVG) using Recharts' built-in export
- Consider adding zoom/pan for time-series data via `recharts-zoom-pan` or custom brush component
