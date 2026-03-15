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
  type?: "line" | "bar" | "area";
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
  // Backward-compat aliases (agent prompt uses these)
  xKey?: string;
}

/** Normalize chart spec — handle backward-compat aliases from agent prompt */
function normalizeSpec(raw: ChartSpec): ChartSpec {
  // xKey -> xAxis.dataKey
  if (raw.xKey && !raw.xAxis?.dataKey) {
    raw.xAxis = { ...raw.xAxis, dataKey: raw.xKey };
  }
  // series[].key -> series[].dataKey
  if (raw.series) {
    raw.series = raw.series.map((s: any) => ({
      ...s,
      dataKey: s.dataKey || s.key,
    }));
  }
  return raw;
}

const DEFAULT_COLORS = [
  "#8884d8", "#82ca9d", "#ffc658", "#ff7c7c", "#8dd1e1",
  "#a4de6c", "#d0ed57", "#ffa07a", "#dda0dd", "#87ceeb",
];

function parseChartSpec(content: string): ChartSpec {
  const spec = JSON.parse(content) as Record<string, unknown>;
  if (!spec.type || !Array.isArray(spec.data)) {
    throw new Error("Chart spec requires 'type' and 'data' array");
  }
  return normalizeSpec(spec as unknown as ChartSpec);
}

function renderChartContent(spec: ChartSpec, series: ChartSeries[], xDataKey: string): React.ReactElement {
  const grid = <CartesianGrid strokeDasharray="3 3" />;
  const xAxis = (
    <XAxis
      dataKey={xDataKey}
      label={spec.xAxis?.label ? { value: spec.xAxis.label, position: "insideBottom", offset: -5 } : undefined}
    />
  );
  const yAxis = (
    <YAxis
      label={spec.yAxis?.label ? { value: spec.yAxis.label, angle: -90, position: "insideLeft" } : undefined}
    />
  );
  const tooltip = <Tooltip />;
  const legend = <Legend />;

  switch (spec.type) {
    case "line":
      return (
        <LineChart data={spec.data}>
          {grid}{xAxis}{yAxis}{tooltip}{legend}
          {series.map((s, i) => (
            <Line
              key={s.dataKey}
              type="monotone"
              dataKey={s.dataKey}
              stroke={s.color ?? DEFAULT_COLORS[i % DEFAULT_COLORS.length]}
              name={s.name ?? s.dataKey}
            />
          ))}
        </LineChart>
      );

    case "bar":
      return (
        <BarChart data={spec.data}>
          {grid}{xAxis}{yAxis}{tooltip}{legend}
          {series.map((s, i) => (
            <Bar
              key={s.dataKey}
              dataKey={s.dataKey}
              fill={s.color ?? DEFAULT_COLORS[i % DEFAULT_COLORS.length]}
              name={s.name ?? s.dataKey}
            />
          ))}
        </BarChart>
      );

    case "area":
      return (
        <AreaChart data={spec.data}>
          {grid}{xAxis}{yAxis}{tooltip}{legend}
          {series.map((s, i) => {
            const color = s.color ?? DEFAULT_COLORS[i % DEFAULT_COLORS.length];
            return (
              <Area
                key={s.dataKey}
                type="monotone"
                dataKey={s.dataKey}
                stroke={color}
                fill={color}
                fillOpacity={0.3}
                name={s.name ?? s.dataKey}
              />
            );
          })}
        </AreaChart>
      );

    case "scatter":
      return (
        <ScatterChart>
          {grid}{xAxis}{yAxis}{tooltip}{legend}
          {series.map((s, i) => (
            <Scatter
              key={s.dataKey}
              data={spec.data}
              dataKey={s.dataKey}
              fill={s.color ?? DEFAULT_COLORS[i % DEFAULT_COLORS.length]}
              name={s.name ?? s.dataKey}
            />
          ))}
        </ScatterChart>
      );

    case "pie":
      return (
        <PieChart>
          <Pie
            data={spec.data}
            dataKey={spec.dataKey ?? "value"}
            nameKey={spec.nameKey ?? "name"}
            cx="50%"
            cy="50%"
            outerRadius={120}
            label
          >
            {spec.data.map((_entry, i) => (
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
            const color = s.color ?? DEFAULT_COLORS[i % DEFAULT_COLORS.length];
            const name = s.name ?? s.dataKey;
            switch (s.type) {
              case "bar":
                return <Bar key={s.dataKey} dataKey={s.dataKey} fill={color} name={name} />;
              case "area":
                return (
                  <Area
                    key={s.dataKey}
                    type="monotone"
                    dataKey={s.dataKey}
                    stroke={color}
                    fill={color}
                    fillOpacity={0.3}
                    name={name}
                  />
                );
              default:
                return (
                  <Line
                    key={s.dataKey}
                    type="monotone"
                    dataKey={s.dataKey}
                    stroke={color}
                    name={name}
                  />
                );
            }
          })}
        </ComposedChart>
      );

    default:
      return <div>Unsupported chart type: {(spec as ChartSpec).type}</div>;
  }
}

export default function ChartRenderer({ content }: { content: string }) {
  const result = useMemo(() => {
    try {
      return { spec: parseChartSpec(content), error: null };
    } catch (e) {
      return { spec: null, error: e instanceof Error ? e.message : String(e) };
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
        {renderChartContent(spec, series, xDataKey)}
      </ResponsiveContainer>
    </div>
  );
}
