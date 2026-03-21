// Interactive component primitives for Model B declarative artifacts.
// Each component is a pure presentational element driven by the InteractiveRenderer state.

import type React from "react";
import { useRef } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { ComponentSpec } from "./interactive-types";

export type { ComponentSpec };

interface BaseProps {
  disabled: boolean;
  value: unknown;
  onChange: (id: string, value: unknown) => void;
}

// ── Text (renders markdown like message content) ────────────────────────────
export function TextComponent({ spec }: { spec: ComponentSpec }) {
  return (
    <div className="interactive-text">
      <Markdown remarkPlugins={[remarkGfm]}>{String(spec.content ?? "")}</Markdown>
    </div>
  );
}

// ── Button ────────────────────────────────────────────────────────────────────
export function ButtonComponent({
  spec,
  disabled,
  onAction,
  isSelected,
}: {
  spec: ComponentSpec;
  disabled: boolean;
  onAction: (id: string, value: unknown) => void;
  isSelected?: boolean;
}) {
  const style = isSelected ? "selected" : ((spec.style as string) ?? "secondary");
  const isDisabled = disabled || (spec.disabled as boolean);
  const reasonId = `btn-reason-${spec.id}`;
  const disabledReason = spec.disabled_reason != null ? String(spec.disabled_reason) : null;

  return (
    <>
      {isDisabled && disabledReason && (
        <span id={reasonId} className="sr-only">
          {disabledReason}
        </span>
      )}
      <button
        type="button"
        className={`interactive-btn interactive-btn--${style}`}
        disabled={isDisabled}
        aria-pressed={isSelected}
        aria-label={String(spec.label ?? spec.id)}
        aria-describedby={isDisabled && disabledReason ? reasonId : undefined}
        onClick={() => onAction(String(spec.id ?? ""), spec.value ?? spec.id)}
      >
        {String(spec.label ?? spec.id)}
      </button>
    </>
  );
}

// ── ButtonGroup (selects a value — local state only, no server submit) ───────
export function ButtonGroupComponent({
  spec,
  disabled,
  onAction,
  selectedValue,
}: {
  spec: ComponentSpec;
  disabled: boolean;
  onAction: (id: string, value: unknown) => void;
  selectedValue?: unknown;
}) {
  const buttons = (spec.buttons as ComponentSpec[]) ?? [];
  const stackClass = buttons.length > 3 ? " interactive-btn-group--stack" : "";
  const groupId = String(spec.id ?? "");

  return (
    <div
      className={`interactive-btn-group${stackClass}`}
      role="group"
      aria-label={String(spec.label ?? spec.id ?? "options")}
    >
      {buttons.map((btn, i) => {
        const btnValue = btn.value ?? btn.id;
        const isSelected = selectedValue != null && String(btnValue) === String(selectedValue);
        return (
          <ButtonComponent
            key={btn.id ?? i}
            spec={btn}
            disabled={disabled}
            onAction={() => onAction(groupId, btnValue)}
            isSelected={isSelected}
          />
        );
      })}
    </div>
  );
}

// ── TextInput ─────────────────────────────────────────────────────────────────
export function TextInputComponent({ spec, disabled, value, onChange }: BaseProps & { spec: ComponentSpec }) {
  const inputRef = useRef<HTMLTextAreaElement & HTMLInputElement>(null);
  const id = String(spec.id ?? "");
  const labelId = `input-label-${id}`;
  const hintId = `input-hint-${id}`;
  const strVal = String(value ?? "");
  const maxLen = spec.max_length as number | undefined;

  const handleFocus = () => {
    inputRef.current?.scrollIntoView({ block: "nearest" });
  };

  const commonProps = {
    id,
    className: "interactive-input",
    disabled,
    value: strVal,
    placeholder: String(spec.placeholder ?? ""),
    maxLength: maxLen,
    "aria-labelledby": labelId,
    "aria-describedby": spec.hint ? hintId : undefined,
    "aria-required": !!spec.required,
    onFocus: handleFocus,
  };
  const labelStr = String(spec.label ?? spec.id);
  const hintStr = spec.hint != null ? String(spec.hint) : null;

  return (
    <div className="interactive-field">
      <label id={labelId} htmlFor={id} className="interactive-label">
        {labelStr}
        {!!spec.required && <span aria-hidden="true"> *</span>}
      </label>
      {spec.multiline ? (
        <textarea
          ref={inputRef as React.Ref<HTMLTextAreaElement>}
          {...commonProps}
          rows={4}
          style={{ resize: "vertical" }}
          onChange={(e) => onChange(id, e.target.value)}
        />
      ) : (
        <input
          type="text"
          ref={inputRef as React.Ref<HTMLInputElement>}
          {...commonProps}
          onChange={(e) => onChange(id, e.target.value)}
        />
      )}
      <div className="interactive-field-footer">
        {hintStr && (
          <span id={hintId} className="interactive-hint">
            {hintStr}
          </span>
        )}
        {maxLen && (
          <span className="interactive-char-count" aria-live="polite">
            {strVal.length}/{maxLen}
          </span>
        )}
      </div>
    </div>
  );
}

// ── Select ────────────────────────────────────────────────────────────────────
export function SelectComponent({ spec, disabled, value, onChange }: BaseProps & { spec: ComponentSpec }) {
  const id = String(spec.id ?? "");
  const hintId = `select-hint-${id}`;
  const options = (spec.options as { label: string; value: string }[]) ?? [];

  return (
    <div className="interactive-field">
      <label htmlFor={id} className="interactive-label">
        {String(spec.label ?? spec.id)}
        {!!spec.required && <span aria-hidden="true"> *</span>}
      </label>
      <div className="interactive-select-wrap">
        <select
          id={id}
          className="interactive-select"
          disabled={disabled}
          value={String(value ?? "")}
          aria-describedby={spec.hint ? hintId : undefined}
          onChange={(e) => onChange(id, e.target.value)}
        >
          {!!spec.placeholder && (
            <option value="" disabled>
              {String(spec.placeholder)}
            </option>
          )}
          {options.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </select>
      </div>
      {!!spec.hint && (
        <span id={hintId} className="interactive-hint">
          {String(spec.hint)}
        </span>
      )}
    </div>
  );
}

// ── Checkbox ──────────────────────────────────────────────────────────────────
export function CheckboxComponent({ spec, disabled, value, onChange }: BaseProps & { spec: ComponentSpec }) {
  const id = String(spec.id ?? "");
  const hintId = `chk-hint-${id}`;

  return (
    <div className="interactive-field">
      <label htmlFor={id} className="interactive-checkbox-label">
        <input
          type="checkbox"
          id={id}
          className="interactive-checkbox-input"
          disabled={disabled}
          checked={Boolean(value ?? spec.default)}
          aria-describedby={spec.hint ? hintId : undefined}
          onChange={(e) => onChange(id, e.target.checked)}
        />
        <span className="interactive-checkbox-box" aria-hidden="true" />
        <span className="interactive-checkbox-text">{String(spec.label ?? spec.id)}</span>
      </label>
      {!!spec.hint && (
        <span id={hintId} className="interactive-hint" style={{ paddingLeft: "28px" }}>
          {String(spec.hint)}
        </span>
      )}
    </div>
  );
}

// ── Rating ────────────────────────────────────────────────────────────────────
export function RatingComponent({ spec, disabled, value, onChange }: BaseProps & { spec: ComponentSpec }) {
  const id = String(spec.id ?? "");
  const max = (spec.max as number) ?? 5;
  const icon = String(spec.icon ?? "★");
  const current = Number(value ?? 0);

  return (
    <div className="interactive-rating" role="radiogroup" aria-label={String(spec.label ?? spec.id ?? "Rating")}>
      {Array.from({ length: max }, (_, i) => {
        const val = i + 1;
        const selected = val === current;
        return (
          <button
            key={val}
            type="button"
            role="radio"
            aria-checked={selected}
            aria-label={`${val} of ${max}`}
            tabIndex={selected || (current === 0 && val === 1) ? 0 : -1}
            className={`interactive-rating-icon${val <= current ? " interactive-rating-icon--active" : " interactive-rating-icon--inactive"}`}
            disabled={disabled}
            onClick={() => onChange(id, val)}
            onKeyDown={(e) => {
              if (e.key === "ArrowRight" && val < max) onChange(id, val + 1);
              if (e.key === "ArrowLeft" && val > 1) onChange(id, val - 1);
            }}
          >
            {icon}
          </button>
        );
      })}
    </div>
  );
}

// ── Slider ──────────────────────────────────────────────────────────────────
export function SliderComponent({ spec, disabled, value, onChange }: BaseProps & { spec: ComponentSpec }) {
  const id = String(spec.id ?? "");
  const min = (spec.min as number) ?? 0;
  const max = (spec.max as number) ?? 100;
  const step = (spec.step as number) ?? 1;
  const current = Number(value ?? spec.default ?? min);
  const hintId = `slider-hint-${id}`;
  const unit = spec.unit != null ? String(spec.unit) : "";

  return (
    <div className="interactive-field">
      <div className="interactive-slider-header">
        <label htmlFor={id} className="interactive-label">
          {String(spec.label ?? spec.id)}
        </label>
        <span className="interactive-slider-value">
          {current}
          {unit}
        </span>
      </div>
      <input
        type="range"
        id={id}
        className="interactive-slider"
        disabled={disabled}
        min={min}
        max={max}
        step={step}
        value={current}
        aria-describedby={spec.hint ? hintId : undefined}
        aria-valuemin={min}
        aria-valuemax={max}
        aria-valuenow={current}
        onChange={(e) => onChange(id, Number(e.target.value))}
      />
      {!!spec.hint && (
        <span id={hintId} className="interactive-hint">
          {String(spec.hint)}
        </span>
      )}
    </div>
  );
}

// ── Submit (the only component that fires to the server) ────────────────────
export function SubmitComponent({
  spec,
  disabled,
  onSubmit,
}: {
  spec: ComponentSpec;
  disabled: boolean;
  onSubmit: (id: string, value: unknown) => void;
}) {
  const label = String(spec.label ?? "Submit");
  const style = (spec.style as string) ?? "primary";

  return (
    <button
      type="button"
      className={`interactive-btn interactive-btn--${style}`}
      disabled={disabled}
      onClick={() => onSubmit(String(spec.id ?? "submit"), spec.value ?? "submitted")}
    >
      {label}
    </button>
  );
}

// ── Divider ───────────────────────────────────────────────────────────────────
export function DividerComponent() {
  return <hr className="interactive-divider" />;
}
