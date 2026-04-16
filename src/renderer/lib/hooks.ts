import { useCallback, useEffect, useState } from "preact/hooks";

import type { PathActionResult } from "../../shared/contracts";
import { nativeApi } from "../nativeApi";
import { toast } from "../components/Toasts";

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

  return { busy, runAction, handleEasyMove } as const;
}

/** Load the safeDeleteToTrash setting once on mount. */
export function useSafeDeleteOnly(): boolean {
  const [safe, setSafe] = useState(true);
  useEffect(() => {
    void nativeApi.getSettings().then((s) => {
      if (s) setSafe(s.cleanup.safeDeleteToTrash);
    });
  }, []);
  return safe;
}
