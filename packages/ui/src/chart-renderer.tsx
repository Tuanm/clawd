import type React from "react";
import { useMemo } from "react";
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ComposedChart,
  Legend,
  Line,
  LineChart,
  Pie,
  PieChart,
  ResponsiveContainer,
  Scatter,
  ScatterChart,
  Tooltip,
  XAxis,
  YAxis,
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
  // Auto-infer series from data keys when absent (except for pie charts which use dataKey/nameKey)
  if ((!raw.series || raw.series.length === 0) && raw.type !== "pie") {
    const xKey = raw.xAxis?.dataKey ?? raw.xKey ?? "name";
    const sample = Array.isArray(raw.data) && raw.data.length > 0 ? raw.data[0] : {};
    raw.series = Object.keys(sample as Record<string, unknown>)
      .filter((k) => k !== xKey && typeof (sample as Record<string, unknown>)[k] === "number")
      .map((k) => ({ dataKey: k }));
  }
  return raw;
}

// Warm palette that blends with the chat accent (hsl 15 63% 60%)
const DEFAULT_COLORS = [
  "#d97853", // warm orange (accent)
  "#6ba5a5", // muted teal
  "#c4886d", // dusty salmon
  "#7c9eb2", // slate blue
  "#b5a36a", // warm gold
  "#8fab7e", // sage green
  "#a88abf", // soft purple
  "#cc8e8e", // rose
  "#6b9a8a", // deep sage
  "#b0896b", // caramel
];

// Detect dark mode from document
function isDark(): boolean {
  return typeof window !== "undefined" && window.matchMedia?.("(prefers-color-scheme: dark)").matches;
}

function parseChartSpec(content: string): ChartSpec {
  // Strip optional ```json ... ``` wrapper that LLMs commonly produce around JSON
  const stripped = content
    .trim()
    .replace(/^```(?:json)?\s*\n?([\s\S]*?)\n?\s*```$/m, "$1")
    .trim();
  const spec = JSON.parse(stripped) as Record<string, unknown>;
  if (!spec.type || !Array.isArray(spec.data)) {
    throw new Error("Chart spec requires 'type' and 'data' array");
  }
  return normalizeSpec(spec as unknown as ChartSpec);
}

// Shared axis/grid/tooltip props for consistent chat styling
function useChartParts(spec: ChartSpec, xDataKey: string) {
  const dark = isDark();
  const textColor = dark ? "#9ca3af" : "#71717a";
  const gridColor = dark ? "rgba(255,255,255,0.06)" : "rgba(0,0,0,0.06)";
  const tooltipBg = dark ? "#1c2128" : "#ffffff";
  const tooltipBorder = dark ? "#30363d" : "rgba(0,0,0,0.08)";

  const tickStyle = {
    fontSize: 11,
    fill: textColor,
    fontFamily: "Lato, sans-serif",
  };

  const grid = <CartesianGrid stroke={gridColor} strokeDasharray="3 3" vertical={false} />;
  const xAxis = (
    <XAxis
      dataKey={xDataKey}
      tick={tickStyle}
      tickLine={false}
      axisLine={{ stroke: gridColor }}
      label={
        spec.xAxis?.label
          ? {
              value: spec.xAxis.label,
              position: "insideBottom",
              offset: -5,
              style: { ...tickStyle, fontSize: 12 },
            }
          : undefined
      }
    />
  );
  const yAxis = (
    <YAxis
      tick={tickStyle}
      tickLine={false}
      axisLine={false}
      width={40}
      label={
        spec.yAxis?.label
          ? {
              value: spec.yAxis.label,
              angle: -90,
              position: "insideLeft",
              style: { ...tickStyle, fontSize: 12 },
            }
          : undefined
      }
    />
  );
  const tooltip = (
    <Tooltip
      contentStyle={{
        background: tooltipBg,
        border: `1px solid ${tooltipBorder}`,
        borderRadius: 6,
        boxShadow: "0 2px 8px rgba(0,0,0,0.1)",
        fontSize: 12,
        fontFamily: "Lato, sans-serif",
        padding: "6px 10px",
      }}
      cursor={{ fill: dark ? "rgba(255,255,255,0.04)" : "rgba(0,0,0,0.03)" }}
    />
  );
  const legend = (
    <Legend
      wrapperStyle={{
        fontSize: 11,
        fontFamily: "Lato, sans-serif",
        paddingTop: 4,
      }}
      iconType="circle"
      iconSize={8}
    />
  );

  return { grid, xAxis, yAxis, tooltip, legend };
}

type ChartParts = ReturnType<typeof useChartParts>;

function renderChartContent(spec: ChartSpec, series: ChartSeries[], parts: ChartParts): React.ReactElement {
  const { grid, xAxis, yAxis, tooltip, legend } = parts;
  const margin = { top: 8, right: 12, bottom: 4, left: 0 };

  switch (spec.type) {
    case "line":
      return (
        <LineChart data={spec.data} margin={margin}>
          {grid}
          {xAxis}
          {yAxis}
          {tooltip}
          {legend}
          {series.map((s, i) => {
            const color = s.color ?? DEFAULT_COLORS[i % DEFAULT_COLORS.length];
            return (
              <Line
                key={s.dataKey}
                type="monotone"
                dataKey={s.dataKey}
                stroke={color}
                strokeWidth={2}
                dot={{ r: 3, strokeWidth: 0, fill: color }}
                activeDot={{ r: 5, strokeWidth: 0, fill: color }}
                name={s.name ?? s.dataKey}
              />
            );
          })}
        </LineChart>
      );

    case "bar":
      return (
        <BarChart data={spec.data} margin={margin} barCategoryGap="20%">
          {grid}
          {xAxis}
          {yAxis}
          {tooltip}
          {legend}
          {series.map((s, i) => (
            <Bar
              key={s.dataKey}
              dataKey={s.dataKey}
              fill={s.color ?? DEFAULT_COLORS[i % DEFAULT_COLORS.length]}
              radius={[3, 3, 0, 0]}
              name={s.name ?? s.dataKey}
            />
          ))}
        </BarChart>
      );

    case "area":
      return (
        <AreaChart data={spec.data} margin={margin}>
          {grid}
          {xAxis}
          {yAxis}
          {tooltip}
          {legend}
          {series.map((s, i) => {
            const color = s.color ?? DEFAULT_COLORS[i % DEFAULT_COLORS.length];
            return (
              <Area
                key={s.dataKey}
                type="monotone"
                dataKey={s.dataKey}
                stroke={color}
                strokeWidth={2}
                fill={color}
                fillOpacity={0.15}
                name={s.name ?? s.dataKey}
              />
            );
          })}
        </AreaChart>
      );

    case "scatter":
      return (
        <ScatterChart margin={margin}>
          {grid}
          {xAxis}
          {yAxis}
          {tooltip}
          {legend}
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

    case "pie": {
      const dark = isDark();
      const textColor = dark ? "#9ca3af" : "#71717a";
      return (
        <PieChart>
          <Pie
            data={spec.data}
            dataKey={spec.dataKey ?? "value"}
            nameKey={spec.nameKey ?? "name"}
            cx="50%"
            cy="50%"
            outerRadius="75%"
            innerRadius="40%"
            paddingAngle={2}
            stroke="none"
            label
            labelLine={{ stroke: textColor, strokeWidth: 1 }}
          >
            {spec.data.map((_entry, i) => (
              <Cell key={`cell-${i}`} fill={DEFAULT_COLORS[i % DEFAULT_COLORS.length]} />
            ))}
          </Pie>
          <Tooltip
            contentStyle={{
              background: dark ? "#1c2128" : "#ffffff",
              border: `1px solid ${dark ? "#30363d" : "rgba(0,0,0,0.08)"}`,
              borderRadius: 6,
              boxShadow: "0 2px 8px rgba(0,0,0,0.1)",
              fontSize: 12,
              fontFamily: "Lato, sans-serif",
              padding: "6px 10px",
            }}
          />
          <Legend
            wrapperStyle={{
              fontSize: 11,
              fontFamily: "Lato, sans-serif",
              paddingTop: 4,
            }}
            iconType="circle"
            iconSize={8}
          />
        </PieChart>
      );
    }

    case "composed":
      return (
        <ComposedChart data={spec.data} margin={margin}>
          {grid}
          {xAxis}
          {yAxis}
          {tooltip}
          {legend}
          {series.map((s, i) => {
            const color = s.color ?? DEFAULT_COLORS[i % DEFAULT_COLORS.length];
            const name = s.name ?? s.dataKey;
            switch (s.type) {
              case "bar":
                return <Bar key={s.dataKey} dataKey={s.dataKey} fill={color} radius={[3, 3, 0, 0]} name={name} />;
              case "area":
                return (
                  <Area
                    key={s.dataKey}
                    type="monotone"
                    dataKey={s.dataKey}
                    stroke={color}
                    strokeWidth={2}
                    fill={color}
                    fillOpacity={0.15}
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
                    strokeWidth={2}
                    dot={{ r: 3, strokeWidth: 0, fill: color }}
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
  const parts = useChartParts(spec, xDataKey);

  return (
    <div className="artifact-chart">
      {spec.title && <div className="artifact-chart-title">{spec.title}</div>}
      <ResponsiveContainer width="100%" height={300}>
        {renderChartContent(spec, series, parts)}
      </ResponsiveContainer>
    </div>
  );
}
