import { useCallback, useEffect, useState } from "preact/hooks";

import type { AppSettings, DiskSpaceInfo, PathActionResult } from "../../shared/contracts";
import {
  findExcludedFolderActionBlocker,
  findExcludedFolderForPath,
  normalizeExcludedFolderPaths,
  type ProtectionPlatform,
} from "../../shared/pathProtection";
import { nativeApi } from "../nativeApi";
import { toast } from "../components/Toasts";
import { markDeletedPath, type DeletedPathAction } from "./deletedPaths";
import { dispatchSettingsUpdated, SETTINGS_UPDATED_EVENT } from "./uiEvents";

const DEFAULT_DISK_SPACE_REFRESH_MS = 10_000;

function diskSpaceEqual(a: DiskSpaceInfo[], b: DiskSpaceInfo[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const left = a[i]!;
    const right = b[i]!;
    if (
      left.drive !== right.drive ||
      left.totalBytes !== right.totalBytes ||
      left.freeBytes !== right.freeBytes ||
      left.usedBytes !== right.usedBytes
    ) {
      return false;
    }
  }
  return true;
}

export function useLiveDiskSpace(refreshMs = DEFAULT_DISK_SPACE_REFRESH_MS) {
  const [drives, setDrives] = useState<DiskSpaceInfo[]>([]);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const next = await nativeApi.getDiskSpace();
      if (Array.isArray(next)) {
        setDrives((prev) => (diskSpaceEqual(prev, next) ? prev : next));
      }
    } catch {
      // Non-fatal telemetry read. Keep the last known drive list.
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    const run = async () => {
      try {
        const next = await nativeApi.getDiskSpace();
        if (cancelled) return;
        if (Array.isArray(next)) {
          setDrives((prev) => (diskSpaceEqual(prev, next) ? prev : next));
        }
      } catch {
        // Non-fatal telemetry read. Keep the last known drive list.
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    void run();
    const id = window.setInterval(() => void run(), refreshMs);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [refreshMs]);

  return { drives, loading, refresh } as const;
}

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
    opts?: { dismiss?: boolean; onSuccess?: () => void; deletedAction?: DeletedPathAction },
  ) => {
    markBusy(path);
    const r = await action();
    clearBusy(path);
    if (r.ok) {
      if (opts?.deletedAction) markDeletedPath(path, opts.deletedAction);
      if (opts?.onSuccess) opts.onSuccess();
      else if (opts?.dismiss || opts?.deletedAction) toast("success", r.message);
    } else {
      toast("error", "Action failed", r.message);
    }
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

export function useExcludedFolderProtection() {
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const platform = nativeApi.platform as ProtectionPlatform;

  useEffect(() => {
    void nativeApi.getSettings().then((s) => {
      if (s) setSettings(s);
    });

    const handleSettings = (event: Event) => {
      const detail = (event as CustomEvent<AppSettings>).detail;
      if (detail) setSettings(detail);
    };
    const unsubscribeNative = nativeApi.onSettingsUpdated((next) => {
      if (next) setSettings(next);
    });

    window.addEventListener(SETTINGS_UPDATED_EVENT, handleSettings as EventListener);
    return () => {
      window.removeEventListener(SETTINGS_UPDATED_EVENT, handleSettings as EventListener);
      unsubscribeNative();
    };
  }, []);

  const excludedFolderPaths = settings?.scanning.excludedFolderPaths ?? [];

  const findProtectedFolder = useCallback((path: string): string | null => {
    return findExcludedFolderForPath(path, excludedFolderPaths, platform);
  }, [excludedFolderPaths, platform]);

  const findProtectionBlocker = useCallback((path: string) => {
    return findExcludedFolderActionBlocker(path, excludedFolderPaths, platform);
  }, [excludedFolderPaths, platform]);

  const isProtectedPath = useCallback((path: string): boolean => {
    return findProtectionBlocker(path) !== null;
  }, [findProtectionBlocker]);

  const addExcludedFolder = useCallback(async (folderPath: string): Promise<boolean> => {
    const current = await nativeApi.getSettings();
    if (!current) {
      toast("error", "Settings unavailable");
      return false;
    }
    const nextPaths = normalizeExcludedFolderPaths(
      [...current.scanning.excludedFolderPaths, folderPath],
      platform,
    );
    const alreadyPresent = nextPaths.length === current.scanning.excludedFolderPaths.length;
    const nextSettings: AppSettings = {
      ...current,
      scanning: {
        ...current.scanning,
        excludedFolderPaths: nextPaths,
      },
    };
    try {
      await nativeApi.updateSettings(nextSettings);
      setSettings(nextSettings);
      dispatchSettingsUpdated(nextSettings);
      toast(
        alreadyPresent ? "info" : "success",
        alreadyPresent ? "Folder already protected" : "Folder protected",
        folderPath,
      );
      return true;
    } catch {
      toast("error", "Failed to update Protected Folders");
      return false;
    }
  }, [platform]);

  return {
    settings,
    excludedFolderPaths,
    findProtectedFolder,
    findProtectionBlocker,
    isProtectedPath,
    addExcludedFolder,
  } as const;
}
