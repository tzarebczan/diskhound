import { useCallback, useEffect, useState } from "preact/hooks";

import type { AppSettings, PathActionResult } from "../../shared/contracts";
import { nativeApi } from "../nativeApi";
import { toast } from "../components/Toasts";
import { SETTINGS_UPDATED_EVENT } from "./uiEvents";

/** Shared busy-set state with add/remove helpers. */
export function useBusySet() {
  const [busy, setBusy] = useState<Set<string>>(new Set());

  const markBusy = useCallback((path: string) => {
    setBusy((b) => { const n = new Set(b); n.add(path); return n; });
  }, []);

  const clearBusy = useCallback((path: string) => {
    setBusy((b) => { const n = new Set(b); n.delete(path); return n; });
  }, []);

  return { busy, markBusy, clearBusy } as const;
}

/** Run a path action with busy tracking and error toasting. */
export function usePathActions() {
  const { busy, markBusy, clearBusy } = useBusySet();

  const runAction = useCallback(async (
    path: string,
    action: () => Promise<PathActionResult>,
    opts?: { dismiss?: boolean; onSuccess?: () => void },
  ) => {
    markBusy(path);
    const r = await action();
    clearBusy(path);
    if (r.ok && opts?.onSuccess) opts.onSuccess();
    else if (r.ok && opts?.dismiss) toast("success", r.message);
    else if (!r.ok) toast("error", "Action failed", r.message);
    return r;
  }, [markBusy, clearBusy]);

  const handleEasyMove = useCallback(async (sourcePath: string) => {
    const dest = await nativeApi.pickMoveDestination();
    if (!dest) return;
    markBusy(sourcePath);
    const result = await nativeApi.easyMove(sourcePath, dest);
    clearBusy(sourcePath);
    if (result?.ok) {
      toast("success", "Moved & linked", result.message);
    } else {
      toast("error", "Easy Move failed", result?.message ?? "Unknown error");
    }
  }, [markBusy, clearBusy]);

  /**
   * Move many files in one gesture: pick a destination once, then move each
   * source into it. Returns the paths that were moved successfully so callers
   * can dismiss them from their list.
   */
  const handleEasyMoveBatch = useCallback(async (sourcePaths: string[]): Promise<string[]> => {
    if (sourcePaths.length === 0) return [];
    const dest = await nativeApi.pickMoveDestination();
    if (!dest) return [];

    const moved: string[] = [];
    const failures: { path: string; message: string }[] = [];

    for (const path of sourcePaths) {
      markBusy(path);
      try {
        const result = await nativeApi.easyMove(path, dest);
        if (result?.ok) {
          moved.push(path);
        } else {
          failures.push({ path, message: result?.message ?? "Unknown error" });
        }
      } catch (err) {
        failures.push({ path, message: err instanceof Error ? err.message : String(err) });
      } finally {
        clearBusy(path);
      }
    }

    if (moved.length > 0) {
      toast(
        "success",
        `Moved ${moved.length} file(s) & linked`,
        failures.length > 0 ? `${failures.length} failed` : undefined,
      );
    }
    if (failures.length > 0 && moved.length === 0) {
      toast("error", "Easy Move failed", failures[0]?.message ?? "Unknown error");
    }
    return moved;
  }, [markBusy, clearBusy]);

  return {
    busy,
    markBusy,
    clearBusy,
    runAction,
    handleEasyMove,
    handleEasyMoveBatch,
  } as const;
}

/** Load the safeDeleteToTrash setting once on mount. */
export function useSafeDeleteOnly(): boolean {
  const [safe, setSafe] = useState(true);

  useEffect(() => {
    void nativeApi.getSettings().then((s) => {
      if (s) setSafe(s.cleanup.safeDeleteToTrash);
    });

    const handleSettings = (event: Event) => {
      const detail = (event as CustomEvent<AppSettings>).detail;
      if (detail) {
        setSafe(detail.cleanup.safeDeleteToTrash);
      }
    };

    window.addEventListener(SETTINGS_UPDATED_EVENT, handleSettings as EventListener);
    return () => {
      window.removeEventListener(SETTINGS_UPDATED_EVENT, handleSettings as EventListener);
    };
  }, []);

  return safe;
}
