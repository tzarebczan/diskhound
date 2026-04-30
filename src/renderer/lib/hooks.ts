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
      return;
    }
    // Permission-denied path — offer a UAC-elevated retry. Most users
    // hit this on Windows-protected files (\Windows\LiveKernelReports
    // dumps, etc.); one UAC prompt is worth it rather than making them
    // relaunch the whole app as admin.
    if (result?.requiresElevation) {
      const ok = window.confirm(
        `${result.message}\n\n` +
        `Retry with admin rights? Windows will show a UAC prompt.`,
      );
      if (!ok) {
        toast("info", "Move cancelled");
        return;
      }
      markBusy(sourcePath);
      const elevated = await nativeApi.easyMoveElevated(sourcePath, dest);
      clearBusy(sourcePath);
      if (elevated?.ok) {
        toast("success", "Moved & linked (admin)", elevated.message);
      } else {
        toast("error", "Elevated move failed", elevated?.message ?? "Unknown error");
      }
      return;
    }
    toast("error", "Easy Move failed", result?.message ?? "Unknown error");
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

    // Batch-level elevation strategy: try each file non-elevated; if
    // any comes back with `requiresElevation`, collect them and prompt
    // ONCE at the end rather than per-file. Saves the user from 10×
    // UAC prompts when cleaning out a folder full of protected files.
    const pendingElevated: string[] = [];
    for (const path of sourcePaths) {
      markBusy(path);
      try {
        const result = await nativeApi.easyMove(path, dest);
        if (result?.ok) {
          moved.push(path);
        } else if (result?.requiresElevation) {
          pendingElevated.push(path);
        } else {
          failures.push({ path, message: result?.message ?? "Unknown error" });
        }
      } catch (err) {
        failures.push({ path, message: err instanceof Error ? err.message : String(err) });
      } finally {
        clearBusy(path);
      }
    }
    if (pendingElevated.length > 0) {
      const ok = window.confirm(
        `${pendingElevated.length} file${pendingElevated.length === 1 ? "" : "s"} ` +
        `need admin rights. Windows will show one UAC prompt per file.\n\nContinue?`,
      );
      if (ok) {
        for (const path of pendingElevated) {
          markBusy(path);
          try {
            const elevated = await nativeApi.easyMoveElevated(path, dest);
            if (elevated?.ok) {
              moved.push(path);
            } else {
              failures.push({
                path,
                message: elevated?.message ?? "Elevated move failed",
              });
            }
          } catch (err) {
            failures.push({
              path,
              message: err instanceof Error ? err.message : String(err),
            });
          } finally {
            clearBusy(path);
          }
        }
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

/**
 * Reactive read of the `confirmPermanentDelete` cleanup setting.
 * FileList uses this to decide whether the per-row "Del" button
 * pops a confirm dialog or fires immediately. Bulk delete always
 * confirms regardless of this value (multi-target actions are a
 * different scale of regret).
 *
 * Defaults to `true` until the first read returns — safer if the
 * preload bridge dies mid-session and we can't read the real
 * setting.
 */
export function useConfirmPermanentDelete(): boolean {
  const [confirmDelete, setConfirmDelete] = useState(true);

  useEffect(() => {
    void nativeApi.getSettings().then((s) => {
      if (s) setConfirmDelete(s.cleanup.confirmPermanentDelete);
    });

    const handleSettings = (event: Event) => {
      const detail = (event as CustomEvent<AppSettings>).detail;
      if (detail) {
        setConfirmDelete(detail.cleanup.confirmPermanentDelete);
      }
    };

    window.addEventListener(SETTINGS_UPDATED_EVENT, handleSettings as EventListener);
    return () => {
      window.removeEventListener(SETTINGS_UPDATED_EVENT, handleSettings as EventListener);
    };
  }, []);

  return confirmDelete;
}
