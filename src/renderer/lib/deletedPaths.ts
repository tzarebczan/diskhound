import { useCallback, useEffect, useMemo, useState } from "preact/hooks";

export type DeletedPathAction = "trash" | "delete";

export interface DeletedPathRecord {
  path: string;
  action: DeletedPathAction;
  deletedAt: number;
}

const DELETED_PATHS_EVENT = "diskhound:deleted-paths-updated";
const deletedByKey = new Map<string, DeletedPathRecord>();

function pathKey(path: string): string {
  const trimmed = path.trim();
  const looksWindows = /^[A-Za-z]:[\\/]/.test(trimmed) || trimmed.includes("\\");
  const normalized = looksWindows ? trimmed.replace(/\//g, "\\") : trimmed;
  return looksWindows ? normalized.toLowerCase() : normalized;
}

function emitDeletedPathsUpdated(): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new Event(DELETED_PATHS_EVENT));
}

export function markDeletedPath(path: string, action: DeletedPathAction): void {
  deletedByKey.set(pathKey(path), {
    path,
    action,
    deletedAt: Date.now(),
  });
  emitDeletedPathsUpdated();
}

export function markDeletedPaths(paths: string[], action: DeletedPathAction): void {
  if (paths.length === 0) return;
  const deletedAt = Date.now();
  for (const path of paths) {
    deletedByKey.set(pathKey(path), { path, action, deletedAt });
  }
  emitDeletedPathsUpdated();
}

export function clearDeletedPaths(): void {
  if (deletedByKey.size === 0) return;
  deletedByKey.clear();
  emitDeletedPathsUpdated();
}

export function deletedPathLabel(record: DeletedPathRecord): string {
  return record.action === "trash" ? "Trashed" : "Deleted";
}

export function deletedPathTitle(record: DeletedPathRecord): string {
  return record.action === "trash"
    ? "Moved to trash in this session. It will clear from this UI on the next scan."
    : "Permanently deleted in this session. It will clear from this UI on the next scan.";
}

export function useDeletedPaths() {
  const [version, setVersion] = useState(0);

  useEffect(() => {
    const onUpdated = () => setVersion((v) => v + 1);
    window.addEventListener(DELETED_PATHS_EVENT, onUpdated);
    return () => window.removeEventListener(DELETED_PATHS_EVENT, onUpdated);
  }, []);

  const getDeletedRecord = useCallback((path: string): DeletedPathRecord | null => {
    void version;
    return deletedByKey.get(pathKey(path)) ?? null;
  }, [version]);

  return useMemo(() => ({
    count: deletedByKey.size,
    records: Array.from(deletedByKey.values()),
    getDeletedRecord,
    isDeleted: (path: string) => getDeletedRecord(path) !== null,
    version,
  }), [getDeletedRecord, version]);
}
