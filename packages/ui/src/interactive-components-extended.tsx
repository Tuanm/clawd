// Extended interactive component primitives — toggle, radio_group, number_input,
// date_picker, image, table, tabs, chart.
// Display-only: image, table, chart. Interactive: toggle, radio_group, number_input, date_picker, tabs.

import React, { Suspense } from "react";
import type { ComponentSpec } from "./interactive-types";

const ChartRenderer = React.lazy(() => import("./chart-renderer"));

interface BaseProps {
  disabled: boolean;
  value: unknown;
  onChange: (id: string, value: unknown) => void;
}

// ── Toggle ─────────────────────────────────────────────────────────────────
export function ToggleComponent({ spec, disabled, value, onChange }: BaseProps & { spec: ComponentSpec }) {
  const id = String(spec.id ?? "");
  const checked = Boolean(value ?? spec.default ?? false);

  return (
    <div className="interactive-field">
      <label htmlFor={id} className="interactive-toggle-label">
        <span className="interactive-label" style={{ marginBottom: 0 }}>
          {String(spec.label ?? spec.id)}
        </span>
        <span className="interactive-toggle-track" aria-hidden="true">
          <input
            type="checkbox"
            id={id}
            className="interactive-toggle-input"
            role="switch"
            disabled={disabled}
            checked={checked}
            aria-checked={checked}
            onChange={(e) => onChange(id, e.target.checked)}
          />
          <span className="interactive-toggle-thumb" />
        </span>
      </label>
    </div>
  );
}

// ── RadioGroup ────────────────────────────────────────────────────────────
export function RadioGroupComponent({ spec, disabled, value, onChange }: BaseProps & { spec: ComponentSpec }) {
  const id = String(spec.id ?? "");
  const options = (spec.options as { label: string; value: string }[]) ?? [];
  const current = String(value ?? spec.default ?? "");

  return (
    <div className="interactive-field">
      <span className="interactive-label">{String(spec.label ?? spec.id)}</span>
      <div className="interactive-radio-group" role="radiogroup" aria-label={String(spec.label ?? spec.id)}>
        {options.map((opt) => {
          const optId = `${id}-${opt.value}`;
          const isChecked = current === String(opt.value);
          return (
            <label key={opt.value} htmlFor={optId} className="interactive-radio-label">
              <input
                type="radio"
                id={optId}
                name={id}
                className="interactive-radio-input"
                disabled={disabled}
                checked={isChecked}
                value={opt.value}
                aria-checked={isChecked}
                onChange={() => onChange(id, opt.value)}
              />
              <span className="interactive-radio-dot" aria-hidden="true" />
              <span className="interactive-radio-text">{opt.label}</span>
            </label>
          );
        })}
      </div>
    </div>
  );
}

// ── NumberInput ───────────────────────────────────────────────────────────
export function NumberInputComponent({ spec, disabled, value, onChange }: BaseProps & { spec: ComponentSpec }) {
  const id = String(spec.id ?? "");
  const min = spec.min as number | undefined;
  const max = spec.max as number | undefined;
  const step = (spec.step as number) ?? 1;
  const current = Number(value ?? spec.default ?? min ?? 0);

  const clamp = (v: number) => {
    if (min !== undefined && v < min) return min;
    if (max !== undefined && v > max) return max;
    return v;
  };

  return (
    <div className="interactive-field">
      <label htmlFor={id} className="interactive-label">
        {String(spec.label ?? spec.id)}
      </label>
      <div className="interactive-number-input">
        <button
          type="button"
          className="interactive-number-btn"
          disabled={disabled || (min !== undefined && current <= min)}
          aria-label="Decrease"
          onClick={() => onChange(id, clamp(current - step))}
        >
          −
        </button>
        <input
          type="number"
          id={id}
          className="interactive-number-field"
          disabled={disabled}
          value={current}
          min={min}
          max={max}
          step={step}
          onChange={(e) => onChange(id, clamp(Number(e.target.value)))}
        />
        <button
          type="button"
          className="interactive-number-btn"
          disabled={disabled || (max !== undefined && current >= max)}
          aria-label="Increase"
          onClick={() => onChange(id, clamp(current + step))}
        >
          +
        </button>
      </div>
    </div>
  );
}

// ── DatePicker ────────────────────────────────────────────────────────────
export function DatePickerComponent({ spec, disabled, value, onChange }: BaseProps & { spec: ComponentSpec }) {
  const id = String(spec.id ?? "");

  return (
    <div className="interactive-field">
      <label htmlFor={id} className="interactive-label">
        {String(spec.label ?? spec.id)}
      </label>
      <input
        type="date"
        id={id}
        className="interactive-input interactive-date"
        disabled={disabled}
        value={String(value ?? "")}
        onChange={(e) => onChange(id, e.target.value)}
      />
    </div>
  );
}

// ── Image (display only) ──────────────────────────────────────────────────
export function ImageComponent({ spec }: { spec: ComponentSpec }) {
  const width = spec.width as number | undefined;
  return (
    <div className="interactive-image">
      <img
        src={String(spec.src ?? "")}
        alt={String(spec.alt ?? "")}
        style={{ maxWidth: width ? `${width}px` : "100%" }}
      />
    </div>
  );
}

// ── Table (display only) ──────────────────────────────────────────────────
export function TableComponent({ spec }: { spec: ComponentSpec }) {
  const headers = (spec.headers as string[]) ?? [];
  const rows = ((spec.rows as unknown[][]) ?? []).slice(0, 20);

  return (
    <div className="interactive-table-wrap">
      <table className="interactive-table">
        {headers.length > 0 && (
          <thead>
            <tr>
              {headers.map((h) => (
                <th key={h}>{h}</th>
              ))}
            </tr>
          </thead>
        )}
        <tbody>
          {rows.map((row, ri) => (
            <tr key={`row-${ri}-${String(row[0] ?? ri)}`}>
              {(row as unknown[]).map((cell, ci) => (
                <td key={ci}>{String(cell ?? "")}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ── Tabs ──────────────────────────────────────────────────────────────────
export function TabsComponent({ spec, disabled, value, onChange }: BaseProps & { spec: ComponentSpec }) {
  const id = String(spec.id ?? "");
  const tabs = (spec.tabs as { label: string; value: string }[]) ?? [];
  const first = tabs[0]?.value ?? "";
  const current = String(value ?? spec.default ?? first);

  return (
    <div className="interactive-tabs" role="tablist" aria-label={String(spec.label ?? spec.id ?? "tabs")}>
      {tabs.map((tab) => {
        const isActive = current === String(tab.value);
        return (
          <button
            key={tab.value}
            type="button"
            role="tab"
            aria-selected={isActive}
            className={`interactive-tab-btn${isActive ? " interactive-tab-btn--active" : ""}`}
            disabled={disabled}
            onClick={() => onChange(id, tab.value)}
          >
            {tab.label}
          </button>
        );
      })}
    </div>
  );
}

// ── Chart embed (display only, lazy-loaded) ───────────────────────────────
export function ChartEmbedComponent({ spec }: { spec: ComponentSpec }) {
  const content = typeof spec.spec === "string" ? spec.spec : JSON.stringify(spec.spec ?? {});

  return (
    <div className="interactive-chart-embed">
      <Suspense fallback={<div className="interactive-artifact-skeleton" />}>
        <ChartRenderer content={content} />
      </Suspense>
    </div>
  );
}
