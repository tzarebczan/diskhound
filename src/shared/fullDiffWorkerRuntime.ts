import * as FSP from "node:fs/promises";
import * as FS from "node:fs";
import * as Path from "node:path";
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { Worker } from "node:worker_threads";
import { createGunzip } from "node:zlib";

import type { FullDiffResult, FullFileChange } from "./contracts";
import type {
  FullDiffWorkerInput,
  FullDiffWorkerRequest,
  FullDiffWorkerResponse,
} from "./fullDiffWorkerProtocol";

interface FileIndexRecord {
  p: string;
  s: number;
}

/**
 * Compact map entry used for the loaded-fully side of the diff.
 * v0.5.39 collapses the previous `Map<string, FileIndexRecord>` into
 * `Map<string, CompactMapValue>` to shave memory on 7M+ file drives.
 *
 *   Was: Map<key, {p: string, s: number}>
 *        ~ 200B key + 32B object header + 200B p ref + 8B s = ~440B/entry
 *
 *   Now: Map<key, [origPath: string | null, size: number]>
 *        ~ 200B key + 24B array + 200B p ref + 8B s = ~432B/entry
 *        AND we set origPath = null when key === origPath (POSIX
 *        case-sensitive volumes always; Windows when no case-folding
 *        happened) — which on POSIX saves the entire 200B duplicate
 *        path string.
 *
 * For a 7M-file POSIX scan that's ~1.4 GB freed. On Windows the
 * saving is smaller (the lowercased key differs from the original
 * path) but still meaningful for ASCII-only paths where some
 * segments are already lowercase.
 *
 * Tuple chosen over an object because V8 optimises small in-bounds
 * arrays as packed elements — no per-property descriptors.
 */
type CompactMapValue = readonly [origPath: string | null, size: number];

const DEFAULT_LIMIT = 500;
const WINDOWS_PLATFORM = "win32";

function defaultCaseSensitivity(): boolean {
  return process.platform !== WINDOWS_PLATFORM;
}

function normalizeIndexPath(inputPath: string, caseSensitive: boolean): string {
  const trimmed = inputPath.replace(/[\\/]+$/, "");
  return caseSensitive ? trimmed : trimmed.toLowerCase();
}

function isFileIndexRecord(value: unknown): value is FileIndexRecord {
  if (!value || typeof value !== "object") {
    return false;
  }

  const candidate = value as { p?: unknown; s?: unknown; t?: unknown };
  return typeof candidate.p === "string"
    && typeof candidate.s === "number"
    && candidate.t !== "d";
}

async function streamFileIndexRecords(
  filePath: string,
  onRecord: (record: FileIndexRecord, key: string) => void | Promise<void>,
  caseSensitive: boolean,
): Promise<void> {
  if (!FS.existsSync(filePath)) {
    return;
  }

  const gunzip = createGunzip();
  const source = createReadStream(filePath);
  // Worker threads with unhandled stream errors crash the whole
  // worker, which the parent surfaces as a generic "worker exited
  // unexpectedly" error. Attach listeners so the for-await loop
  // surfaces the error as a normal rejection instead.
  source.on("error", () => { /* swallowed */ });
  gunzip.on("error", () => { /* swallowed */ });
  source.pipe(gunzip);

  const rl = createInterface({ input: gunzip, crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line) continue;

    let record: unknown;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }

    if (!isFileIndexRecord(record)) {
      continue;
    }

    await onRecord(record, normalizeIndexPath(record.p, caseSensitive));
  }
}

async function loadFileIndexMap(
  filePath: string,
  caseSensitive: boolean,
): Promise<Map<string, CompactMapValue>> {
  const entries = new Map<string, CompactMapValue>();

  await streamFileIndexRecords(
    filePath,
    (record, key) => {
      // v0.5.39: when the normalised key matches the original path
      // byte-for-byte (POSIX, or Windows paths that happened to be
      // all-lowercase), we don't need to store the original path
      // separately — null means "use the key". On a 7M-file POSIX
      // scan this is every entry; saves ~1.4 GB of duplicate path
      // strings.
      const origPath = record.p === key ? null : record.p;
      entries.set(key, [origPath, record.s]);
    },
    caseSensitive,
  );

  return entries;
}

async function safeFileSize(filePath: string): Promise<number | null> {
  try {
    const stat = await FSP.stat(filePath);
    return stat.isFile() ? stat.size : null;
  } catch {
    return null;
  }
}

function createTopChangeAccumulator(limit: number): {
  add: (change: FullFileChange) => void;
  toSortedArray: () => FullFileChange[];
} {
  const cappedLimit = Math.max(0, Math.floor(limit));
  // Kept sorted ASCENDING by |deltaBytes| — index 0 is the smallest,
  // so dropping the loser after overflow is O(1) at the head via shift
  // (Array shift is O(n) in theory but V8 tiny-array shifts stay cheap).
  //
  // Using a sorted-insertion strategy instead of Array.sort() on every
  // add: a full sort is O(n log n) and was the dominant cost on diffs
  // with millions of changes; a binary insert is O(log n) compare +
  // O(n) splice, so asymptotically the same per-insert in the worst
  // case but with far lower constants and no wasted comparisons over
  // the already-sorted prefix.
  const changes: FullFileChange[] = [];

  const absDelta = (c: FullFileChange) => Math.abs(c.deltaBytes);

  return {
    add(change) {
      if (cappedLimit === 0) {
        return;
      }

      const target = absDelta(change);

      // Fast reject: once we're at capacity, anything smaller than the
      // current smallest top-K entry can be dropped without any work.
      if (changes.length === cappedLimit && target <= absDelta(changes[0]!)) {
        return;
      }

      // Binary search for insertion point (ascending by |delta|).
      let lo = 0;
      let hi = changes.length;
      while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        if (absDelta(changes[mid]!) <= target) lo = mid + 1;
        else hi = mid;
      }
      changes.splice(lo, 0, change);
      if (changes.length > cappedLimit) {
        changes.shift();
      }
    },
    toSortedArray() {
      // Caller wants descending by |delta|. Clone + reverse beats
      // re-sorting because the internal array is already sorted
      // ascending.
      const out = changes.slice();
      out.reverse();
      return out;
    },
  };
}

interface DiffAccumulator {
  addChange: (change: FullFileChange) => void;
  finalize: () => FullDiffResult;
}

function createDiffAccumulator(
  baselineId: string,
  currentId: string,
  limit: number,
): DiffAccumulator {
  let totalChanges = 0;
  let totalAdded = 0;
  let totalRemoved = 0;
  let totalGrew = 0;
  let totalShrank = 0;
  let totalBytesAdded = 0;
  let totalBytesRemoved = 0;

  const topChanges = createTopChangeAccumulator(limit);

  return {
    addChange(change) {
      totalChanges += 1;
      topChanges.add(change);

      switch (change.kind) {
        case "added":
          totalAdded += 1;
          totalBytesAdded += change.size;
          break;
        case "removed":
          totalRemoved += 1;
          totalBytesRemoved += change.previousSize;
          break;
        case "grew":
          totalGrew += 1;
          totalBytesAdded += change.deltaBytes;
          break;
        case "shrank":
          totalShrank += 1;
          totalBytesRemoved += Math.abs(change.deltaBytes);
          break;
      }
    },
    finalize() {
      return {
        baselineId,
        currentId,
        totalChanges,
        totalAdded,
        totalRemoved,
        totalGrew,
        totalShrank,
        totalBytesAdded,
        totalBytesRemoved,
        changes: topChanges.toSortedArray(),
        truncated: totalChanges > Math.max(0, Math.floor(limit)),
      };
    },
  };
}

function defaultChangeLimit(limit?: number): number {
  if (typeof limit !== "number" || !Number.isFinite(limit)) {
    return DEFAULT_LIMIT;
  }

  return Math.max(0, Math.floor(limit));
}

export async function computeFullDiffFromIndexFiles(
  input: FullDiffWorkerInput,
): Promise<FullDiffResult | null> {
  const caseSensitive = input.caseSensitive ?? defaultCaseSensitivity();
  const limit = defaultChangeLimit(input.limit);

  const [baselineSize, currentSize] = await Promise.all([
    safeFileSize(input.baselinePath),
    safeFileSize(input.currentPath),
  ]);

  if (baselineSize === null && currentSize === null) {
    return null;
  }

  const accumulator = createDiffAccumulator(input.baselineId, input.currentId, limit);

  const loadBaselineFirst = currentSize === null
    || (baselineSize !== null && baselineSize <= currentSize);

  if (loadBaselineFirst) {
    const baselineByPath = await loadFileIndexMap(input.baselinePath, caseSensitive);

    await streamFileIndexRecords(
      input.currentPath,
      (currentRecord, key) => {
        const baselineEntry = baselineByPath.get(key);
        if (!baselineEntry) {
          accumulator.addChange({
            path: currentRecord.p,
            kind: "added",
            size: currentRecord.s,
            previousSize: 0,
            deltaBytes: currentRecord.s,
          });
          return;
        }

        baselineByPath.delete(key);
        const [, baselineSizeBytes] = baselineEntry;
        if (currentRecord.s === baselineSizeBytes) {
          return;
        }

        const deltaBytes = currentRecord.s - baselineSizeBytes;
        accumulator.addChange({
          path: currentRecord.p,
          kind: deltaBytes > 0 ? "grew" : "shrank",
          size: currentRecord.s,
          previousSize: baselineSizeBytes,
          deltaBytes,
        });
      },
      caseSensitive,
    );

    // Whatever's left in the baseline map was never seen in current
    // → removed. Use the stored original path when present (case-
    // folded entries on Windows), else fall back to the map key which
    // IS the original path (POSIX, or all-lowercase Windows paths).
    for (const [key, [origPath, size]] of baselineByPath) {
      accumulator.addChange({
        path: origPath ?? key,
        kind: "removed",
        size: 0,
        previousSize: size,
        deltaBytes: -size,
      });
    }
  } else {
    const currentByPath = await loadFileIndexMap(input.currentPath, caseSensitive);

    await streamFileIndexRecords(
      input.baselinePath,
      (baselineRecord, key) => {
        const currentEntry = currentByPath.get(key);
        if (!currentEntry) {
          accumulator.addChange({
            path: baselineRecord.p,
            kind: "removed",
            size: 0,
            previousSize: baselineRecord.s,
            deltaBytes: -baselineRecord.s,
          });
          return;
        }

        currentByPath.delete(key);
        const [currentOrigPath, currentSizeBytes] = currentEntry;
        if (currentSizeBytes === baselineRecord.s) {
          return;
        }

        const deltaBytes = currentSizeBytes - baselineRecord.s;
        accumulator.addChange({
          // Original-case path from the current scan (if differs from
          // the normalised key) — same precedence the streaming-current
          // branch above uses.
          path: currentOrigPath ?? key,
          kind: deltaBytes > 0 ? "grew" : "shrank",
          size: currentSizeBytes,
          previousSize: baselineRecord.s,
          deltaBytes,
        });
      },
      caseSensitive,
    );

    for (const [key, [origPath, size]] of currentByPath) {
      accumulator.addChange({
        path: origPath ?? key,
        kind: "added",
        size,
        previousSize: 0,
        deltaBytes: size,
      });
    }
  }

  return accumulator.finalize();
}

export function resolveBundledFullDiffWorkerPath(baseDir: string): string {
  return Path.join(baseDir, "scan", "fullDiffWorker.cjs");
}

export interface RunFullDiffWorkerOptions {
  workerPath: string;
  signal?: AbortSignal;
}

export async function runFullDiffWorker(
  input: FullDiffWorkerInput,
  options: RunFullDiffWorkerOptions,
): Promise<FullDiffResult | null> {
  // Worker old-gen heap evolution:
  //   Default Node:      ~2 GB — OOMed on 4M-file drives
  //   v0.5.x:            4 GB  — OOMed on 7M-file drives
  //   v0.5.20-ish:       8 GB  — held until a 7.8M-file drive hit it
  //   v0.5.39:           12 GB — paired with the compact-value map
  //                              encoding below
  //
  // Reserved pages don't commit until touched, so small diffs still
  // pay zero extra cost. The 12 GB ceiling means the worker is safe
  // up to roughly 10M-file index pairs on a box with 16+ GB RAM.
  // Beyond that we'd need an external-sort-style streaming merge,
  // which is a much bigger architectural change (tracked separately).
  const worker = new Worker(options.workerPath, {
    resourceLimits: {
      maxOldGenerationSizeMb: 12288,
      maxYoungGenerationSizeMb: 256,
    },
  });
  const requestId = `${Date.now()}-${Math.random().toString(16).slice(2)}`;

  return await new Promise<FullDiffResult | null>((resolve, reject) => {
    let settled = false;

    const settle = (callback: () => void) => {
      if (settled) return;
      settled = true;
      cleanup();
      callback();
    };

    const handleAbort = () => {
      void worker.terminate().finally(() => {
        settle(() => reject(new Error("Full diff worker aborted")));
      });
    };

    const cleanup = () => {
      worker.off("message", onMessage);
      worker.off("error", onError);
      worker.off("exit", onExit);
      options.signal?.removeEventListener("abort", handleAbort);
    };

    const onMessage = (message: FullDiffWorkerResponse) => {
      if (!message || message.requestId !== requestId) {
        return;
      }

      void worker.terminate().finally(() => {
        if (message.type === "result") {
          settle(() => resolve(message.result));
          return;
        }

        settle(() => reject(new Error(message.message)));
      });
    };

    const onError = (error: Error) => {
      settle(() => reject(error));
    };

    const onExit = (code: number) => {
      if (!settled && code !== 0) {
        // Code 1 on a worker thread is almost always the V8 heap
        // running out of room (ERR_WORKER_OUT_OF_MEMORY surfaces as
        // exit code 1 in node:worker_threads). Tag it explicitly so
        // the crash log line reads as a diagnosis rather than a
        // generic "exited with code 1."
        const detail = code === 1
          ? `Full diff worker out of memory (exit code 1). The inputs may exceed the worker's 12 GB heap — this drive is at the edge of what the in-memory diff can handle. The fast top-N summary still works.`
          : `Full diff worker exited with code ${code}`;
        settle(() => reject(new Error(detail)));
      }
    };

    worker.on("message", onMessage);
    worker.on("error", onError);
    worker.on("exit", onExit);

    if (options.signal) {
      if (options.signal.aborted) {
        handleAbort();
        return;
      }
      options.signal.addEventListener("abort", handleAbort, { once: true });
    }

    const request: FullDiffWorkerRequest = {
      type: "compute",
      requestId,
      input,
    };
    worker.postMessage(request);
  });
}
