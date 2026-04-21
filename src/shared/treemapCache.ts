import * as Path from "node:path";

import type { ScanFileRecord } from "./contracts";
import { loadLargestFiles, type IndexRecord } from "./scanIndex";

const DEFAULT_LIMIT = 10_000;
const DEFAULT_MIN_BYTES = 0;
const DEFAULT_MAX_ENTRIES = 6;

export interface TreemapCacheLoadInput {
  scanId: string;
  indexPath: string;
  rootPath?: string;
  limit?: number;
  minBytes?: number;
}

export interface TreemapCacheStats {
  entries: number;
  inflight: number;
  rootsTracked: number;
}

export interface TreemapCache {
  getOrLoad(input: TreemapCacheLoadInput): Promise<ScanFileRecord[]>;
  peek(input: Omit<TreemapCacheLoadInput, "indexPath">): ScanFileRecord[] | undefined;
  prime(input: TreemapCacheLoadInput, records: ScanFileRecord[]): void;
  rememberLatest(rootPath: string, scanId: string): void;
  invalidateScan(scanId: string): void;
  invalidateRoot(rootPath: string): void;
  clear(): void;
  getStats(): TreemapCacheStats;
}

export interface TreemapCacheOptions {
  maxEntries?: number;
  loadLargestFiles?: (
    indexPath: string,
    limit: number,
    minBytes: number,
  ) => Promise<IndexRecord[]>;
}

type EntryKey = string;

export function createTreemapCache(options: TreemapCacheOptions = {}): TreemapCache {
  const maxEntries = Math.max(1, options.maxEntries ?? DEFAULT_MAX_ENTRIES);
  const loadLargestFilesImpl = options.loadLargestFiles ?? loadLargestFiles;

  const entries = new Map<EntryKey, ScanFileRecord[]>();
  const inflight = new Map<EntryKey, Promise<ScanFileRecord[]>>();
  const generations = new Map<string, number>();
  const rootToScanIds = new Map<string, Set<string>>();
  const scanIdToRoot = new Map<string, string>();

  const touch = (key: EntryKey, value: ScanFileRecord[]) => {
    entries.delete(key);
    entries.set(key, value);
  };

  const trim = () => {
    while (entries.size > maxEntries) {
      const oldest = entries.keys().next().value;
      if (oldest === undefined) break;
      entries.delete(oldest);
    }
  };

  const bumpGeneration = (scanId: string): number => {
    const next = (generations.get(scanId) ?? 0) + 1;
    generations.set(scanId, next);
    return next;
  };

  const buildKey = (scanId: string, limit: number, minBytes: number): EntryKey =>
    `${scanId}::${limit}::${minBytes}`;

  const evictEntriesForScan = (scanId: string) => {
    const prefix = `${scanId}::`;
    for (const key of entries.keys()) {
      if (key.startsWith(prefix)) entries.delete(key);
    }
    for (const key of inflight.keys()) {
      if (key.startsWith(prefix)) inflight.delete(key);
    }
  };

  const forgetScanRoot = (scanId: string) => {
    const rootKey = scanIdToRoot.get(scanId);
    if (!rootKey) return;
    scanIdToRoot.delete(scanId);

    const scanIds = rootToScanIds.get(rootKey);
    if (!scanIds) return;
    scanIds.delete(scanId);
    if (scanIds.size === 0) rootToScanIds.delete(rootKey);
  };

  const invalidateScan = (scanId: string) => {
    bumpGeneration(scanId);
    evictEntriesForScan(scanId);
    forgetScanRoot(scanId);
  };

  return {
    async getOrLoad(input) {
      const limit = normalizeLimit(input.limit);
      const minBytes = normalizeMinBytes(input.minBytes);
      const key = buildKey(input.scanId, limit, minBytes);
      const cached = entries.get(key);
      if (cached) {
        touch(key, cached);
        return cached;
      }

      const existing = inflight.get(key);
      if (existing) return existing;

      const startedGeneration = generations.get(input.scanId) ?? 0;
      const pending = loadLargestFilesImpl(input.indexPath, limit, minBytes)
        .then((records) => records.map(toScanFileRecord))
        .then((records) => {
          if ((generations.get(input.scanId) ?? 0) === startedGeneration) {
            entries.set(key, records);
            trim();
          }
          return records;
        })
        .finally(() => {
          inflight.delete(key);
        });

      inflight.set(key, pending);
      return pending;
    },

    peek(input) {
      const limit = normalizeLimit(input.limit);
      const minBytes = normalizeMinBytes(input.minBytes);
      const key = buildKey(input.scanId, limit, minBytes);
      const cached = entries.get(key);
      if (cached) touch(key, cached);
      return cached;
    },

    prime(input, records) {
      const limit = normalizeLimit(input.limit);
      const minBytes = normalizeMinBytes(input.minBytes);
      const key = buildKey(input.scanId, limit, minBytes);
      entries.set(key, records);
      trim();
    },

    rememberLatest(rootPath, scanId) {
      const rootKey = normalizeRootKey(rootPath);
      const previousRootKey = scanIdToRoot.get(scanId);
      if (previousRootKey && previousRootKey !== rootKey) {
        const previousIds = rootToScanIds.get(previousRootKey);
        previousIds?.delete(scanId);
        if (previousIds && previousIds.size === 0) rootToScanIds.delete(previousRootKey);
      }
      const existingIds = rootToScanIds.get(rootKey);
      if (existingIds) {
        for (const existingId of existingIds) {
          if (existingId !== scanId) invalidateScan(existingId);
        }
      }

      let ids = rootToScanIds.get(rootKey);
      if (!ids) {
        ids = new Set<string>();
        rootToScanIds.set(rootKey, ids);
      }
      ids.add(scanId);
      scanIdToRoot.set(scanId, rootKey);
    },

    invalidateScan,

    invalidateRoot(rootPath) {
      const rootKey = normalizeRootKey(rootPath);
      const scanIds = rootToScanIds.get(rootKey);
      if (!scanIds) return;
      for (const scanId of Array.from(scanIds)) {
        invalidateScan(scanId);
      }
    },

    clear() {
      entries.clear();
      inflight.clear();
      generations.clear();
      rootToScanIds.clear();
      scanIdToRoot.clear();
    },

    getStats() {
      return {
        entries: entries.size,
        inflight: inflight.size,
        rootsTracked: rootToScanIds.size,
      };
    },
  };
}

function normalizeLimit(limit?: number): number {
  if (!Number.isFinite(limit) || !limit || limit <= 0) return DEFAULT_LIMIT;
  return Math.floor(limit);
}

function normalizeMinBytes(minBytes?: number): number {
  if (!Number.isFinite(minBytes) || !minBytes || minBytes < 0) return DEFAULT_MIN_BYTES;
  return Math.floor(minBytes);
}

function normalizeRootKey(rootPath: string): string {
  const trimmed = rootPath.replace(/[\\/]+$/, "");
  return process.platform === "win32" ? trimmed.toLowerCase() : trimmed;
}

function toScanFileRecord(record: IndexRecord): ScanFileRecord {
  const name = Path.basename(record.p);
  const parentPath = Path.dirname(record.p);
  const dotIdx = name.lastIndexOf(".");
  const extension = dotIdx > 0 ? name.slice(dotIdx).toLowerCase() : "(no ext)";
  return {
    path: record.p,
    name,
    parentPath,
    extension,
    size: record.s,
    modifiedAt: record.m,
  };
}
