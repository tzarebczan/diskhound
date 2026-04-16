import { useCallback, useEffect, useState } from "preact/hooks";

import type { ToastMessage } from "../../shared/contracts";
import { nativeApi } from "../nativeApi";

// Imperative toast helper for use within the renderer
let externalAddToast: ((toast: ToastMessage) => void) | null = null;
let toastSeq = 0;
export function toast(level: ToastMessage["level"], title: string, body?: string) {
  const msg: ToastMessage = {
    id: `local-${++toastSeq}`,
    level,
    title,
    body,
    dismissAfterMs: 4000,
  };
  externalAddToast?.(msg);
}

export function ToastProvider({ children }: { children: any }) {
  const [toasts, setToasts] = useState<(ToastMessage & { exiting?: boolean })[]>([]);

  const dismiss = useCallback((id: string) => {
    setToasts((t) => t.map((x) => (x.id === id ? { ...x, exiting: true } : x)));
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 220);
  }, []);

  const addToast = useCallback((t: ToastMessage) => {
    setToasts((prev) => [...prev.slice(-6), t]);
    if (t.dismissAfterMs) {
      setTimeout(() => dismiss(t.id), t.dismissAfterMs);
    }
  }, [dismiss]);

  useEffect(() => {
    externalAddToast = addToast;
    return nativeApi.onNotification(addToast);
  }, [addToast]);

  return (
    <>
      {children}
      {toasts.length > 0 && (
        <div className="toast-container">
          {toasts.map((t) => (
            <div key={t.id} className={`toast ${t.exiting ? "exiting" : ""}`}>
              <div className={`toast-icon ${t.level}`} />
              <div className="toast-content">
                <div className="toast-title">{t.title}</div>
                {t.body && <div className="toast-body">{t.body}</div>}
              </div>
              <button className="toast-close" onClick={() => dismiss(t.id)} aria-label="Dismiss">&times;</button>
            </div>
          ))}
        </div>
      )}
    </>
  );
}
