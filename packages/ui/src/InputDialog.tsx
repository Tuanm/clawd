import { type FormEvent, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useFocusTrap } from "./hooks/useFocusTrap";

export interface InputField {
  name: string;
  label: string;
  placeholder?: string;
  type?: "text" | "url" | "password";
  initialValue?: string;
  required?: boolean;
  autoFocus?: boolean;
}

interface Props {
  isOpen: boolean;
  title: string;
  description?: string;
  fields: InputField[];
  submitLabel?: string;
  cancelLabel?: string;
  /** External error to display (e.g. validation failure from a previous submit) */
  errorMessage?: string | null;
  onSubmit: (values: Record<string, string>) => void;
  onCancel: () => void;
}

/**
 * Replacement for `window.prompt` — accessible, themed, multi-field input
 * dialog with focus trap and Escape-to-cancel.
 */
export default function InputDialog({
  isOpen,
  title,
  description,
  fields,
  submitLabel = "OK",
  cancelLabel = "Cancel",
  errorMessage,
  onSubmit,
  onCancel,
}: Props) {
  const dialogRef = useRef<HTMLDivElement>(null);
  useFocusTrap(isOpen, dialogRef);

  const [values, setValues] = useState<Record<string, string>>({});

  useEffect(() => {
    if (isOpen) {
      const initial: Record<string, string> = {};
      for (const f of fields) initial[f.name] = f.initialValue ?? "";
      setValues(initial);
    }
  }, [isOpen, fields]);

  useEffect(() => {
    if (!isOpen) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [isOpen, onCancel]);

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    for (const f of fields) {
      if (f.required && !values[f.name]?.trim()) return;
    }
    onSubmit(values);
  };

  if (!isOpen) return null;

  return createPortal(
    <div className="confirm-overlay" onClick={onCancel}>
      <div
        ref={dialogRef}
        className="confirm-dialog input-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="input-dialog-title"
        aria-describedby={description ? "input-dialog-description" : undefined}
        onClick={(e) => e.stopPropagation()}
      >
        <h3 id="input-dialog-title" className="confirm-dialog-title">
          {title}
        </h3>
        {description && (
          <p id="input-dialog-description" className="confirm-dialog-message">
            {description}
          </p>
        )}
        <form onSubmit={handleSubmit}>
          {fields.map((f, i) => (
            <label key={f.name} className="input-dialog-field">
              <span className="input-dialog-label">{f.label}</span>
              <input
                type={f.type ?? "text"}
                value={values[f.name] ?? ""}
                onChange={(e) => setValues((prev) => ({ ...prev, [f.name]: e.target.value }))}
                placeholder={f.placeholder}
                required={f.required}
                autoFocus={f.autoFocus ?? i === 0}
                className="input-dialog-input"
              />
            </label>
          ))}
          {errorMessage && (
            <div className="input-dialog-error" role="alert">
              {errorMessage}
            </div>
          )}
          <div className="confirm-dialog-actions">
            <button type="button" className="confirm-btn confirm-btn--cancel" onClick={onCancel}>
              {cancelLabel}
            </button>
            <button type="submit" className="confirm-btn confirm-btn--primary">
              {submitLabel}
            </button>
          </div>
        </form>
      </div>
    </div>,
    document.body,
  );
}
