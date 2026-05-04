import { createContext, type ReactNode, useCallback, useContext, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

type ToastVariant = "info" | "success" | "warning" | "error";

interface ToastItem {
  id: number;
  message: string;
  variant: ToastVariant;
  durationMs: number;
}

interface ToastApi {
  show: (message: string, opts?: { variant?: ToastVariant; durationMs?: number }) => void;
  info: (message: string) => void;
  success: (message: string) => void;
  warn: (message: string) => void;
  error: (message: string) => void;
}

const ToastContext = createContext<ToastApi | null>(null);

export function useToast(): ToastApi {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error("useToast must be used inside <ToastProvider>");
  return ctx;
}

let toastIdCounter = 0;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const timersRef = useRef<Map<number, ReturnType<typeof setTimeout>>>(new Map());

  const dismiss = useCallback((id: number) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
    const timer = timersRef.current.get(id);
    if (timer) {
      clearTimeout(timer);
      timersRef.current.delete(id);
    }
  }, []);

  const show = useCallback<ToastApi["show"]>(
    (message, opts = {}) => {
      const id = ++toastIdCounter;
      const variant = opts.variant ?? "info";
      const durationMs = opts.durationMs ?? (variant === "error" ? 6000 : 3500);
      setToasts((prev) => [...prev, { id, message, variant, durationMs }]);
      const timer = setTimeout(() => dismiss(id), durationMs);
      timersRef.current.set(id, timer);
    },
    [dismiss],
  );

  useEffect(() => {
    const timers = timersRef.current;
    return () => {
      timers.forEach((t) => clearTimeout(t));
      timers.clear();
    };
  }, []);

  const api: ToastApi = {
    show,
    info: useCallback((m: string) => show(m, { variant: "info" }), [show]),
    success: useCallback((m: string) => show(m, { variant: "success" }), [show]),
    warn: useCallback((m: string) => show(m, { variant: "warning" }), [show]),
    error: useCallback((m: string) => show(m, { variant: "error" }), [show]),
  };

  return (
    <ToastContext.Provider value={api}>
      {children}
      {createPortal(
        <div className="toast-container" role="region" aria-live="polite" aria-label="Notifications">
          {toasts.map((t) => (
            <div
              key={t.id}
              className={`toast toast--${t.variant}`}
              role={t.variant === "error" ? "alert" : "status"}
              onClick={() => dismiss(t.id)}
            >
              <span className="toast-message">{t.message}</span>
              <button
                type="button"
                className="toast-dismiss"
                onClick={(e) => {
                  e.stopPropagation();
                  dismiss(t.id);
                }}
                aria-label="Dismiss notification"
              >
                ×
              </button>
            </div>
          ))}
        </div>,
        document.body,
      )}
    </ToastContext.Provider>
  );
}
