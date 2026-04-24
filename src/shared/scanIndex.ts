import * as FS from "node:fs";
import * as FSP from "node:fs/promises";
import * as Path from "node:path";
import { createGzip, createGunzip } from "node:zlib";
import { createReadStream, createWriteStream, type WriteStream } from "node:fs";
import { createInterface } from "node:readline";

import type {
  DirectoryHotspot,
  ExtensionBucket,
  FullDiffResult,
  FullFileChange,
  ScanEngine,
  ScanFileRecord,
  ScanSnapshot,
} from "./contracts";
import { createIdleScanSnapshot } from "./contracts";
import { normPath } from "./pathUtils";

const INDEX_DIR = "scan-indexes";
const INDEX_SUFFIX = ".ndjson.gz";
/// Companion sidecar suffix. The Rust scanner writes (or Node builds
/// and persists) a pre-rolled-up folder tree here alongside the
/// NDJSON index. Format: one NDJSON line per parent directory — see
/// main.ts readFolderTreeSidecar/writeFolderTreeSidecar for the
/// canonical schema. Shared here so any code that needs to clean up
/// an index (and its sidecar) has the suffix in one place.
const FOLDER_TREE_SIDECAR_SUFFIX = ".folder-tree.ndjson.gz";

let indexDir = "";

export function initScanIndex(dataDir: string): void {
  indexDir = Path.join(dataDir, INDEX_DIR);
  try {
    FS.mkdirSync(indexDir, { recursive: true });
  } catch { /* exists */ }
}

export function indexFilePath(id: string): string {
  return Path.join(indexDir, `${id}${INDEX_SUFFIX}`);
}

export function folderTreeSidecarPath(id: string): string {
  return Path.join(indexDir, `${id}${FOLDER_TREE_SIDECAR_SUFFIX}`);
}

/**
 * Short NDJSON record: `{"p":"<path>","s":<size>,"m":<mtime>}` for files.
 * Directory entries have no `s` field: `{"p":"<dir-path>","t":"d","m":<mtime>}`.
 * The `t` discriminator is absent/ignored for file entries to keep the format
 * backward-compatible with pre-v0.2.5 indexes (which only had file entries).
 */
export interface IndexRecord {
  p: string;
  s: number;
  m: number;
  /** Optional type: "d" for directories, absent/"f" for files. */
  t?: "d" | "f";
}

/** Directory-mtime record in the same NDJSON stream (no size). */
export interface DirIndexRecord {
  p: string;
  t: "d";
  m: number;
}

/**
 * Open a gzipped NDJSON writer. Call `.write(JSON.stringify(record) + "\n")` per file.
 * Returns a pair: the plain writable to pipe JSON into, and a finalize promise.
 */
export function openIndexWriter(filePath: string): {
  stream: WriteStream;
  finalize: () => Promise<void>;
} {
  FS.mkdirSync(Path.dirname(filePath), { recursive: true });
  const gz = createGzip({ level: 6 });
  const file = createWriteStream(filePath);
  gz.pipe(file);

  let settled = false;
  const finalize = () => new Promise<void>((resolve, reject) => {
    if (settled) return resolve();
    settled = true;
    gz.end(() => {
      file.on("close", () => resolve());
      file.on("error", reject);
    });
  });

  return { stream: gz as unknown as WriteStream, finalize };
}

/** Load an index file into a path-keyed Map. */
export async function loadIndex(filePath: string): Promise<Map<string, IndexRecord>> {
  const map = new Map<string, IndexRecord>();
  if (!FS.existsSync(filePath)) return map;

  const gunzip = createGunzip();
  const source = createReadStream(filePath);
  source.pipe(gunzip);

  const rl = createInterface({ input: gunzip, crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line) continue;
    try {
      const rec = JSON.parse(line) as IndexRecord;
      if (rec && typeof rec.p === "string" && rec.t !== "d") {
        // Only file entries belong in the file-diff map.
        map.set(normPath(rec.p), rec);
      }
    } catch { /* skip malformed lines */ }
  }
  return map;
}

/**
 * Load directory mtimes from an index file into a path-keyed Map.
 * Used by the Phase-1 smart-rescan optimization to skip unchanged subtrees.
 * Returns an empty map for legacy indexes (pre-v0.2.5) that don't include
 * directory entries.
 */
export async function loadDirMtimes(filePath: string): Promise<Map<string, number>> {
  const map = new Map<string, number>();
  if (!FS.existsSync(filePath)) return map;

  const gunzip = createGunzip();
  const source = createReadStream(filePath);
  source.pipe(gunzip);

  const rl = createInterface({ input: gunzip, crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line) continue;
    try {
      const rec = JSON.parse(line) as IndexRecord;
      if (rec && rec.t === "d" && typeof rec.p === "string" && typeof rec.m === "number") {
        map.set(normPath(rec.p), rec.m);
      }
    } catch { /* skip malformed lines */ }
  }
  return map;
}

/**
 * Stream every file record from an index into the given per-dir bucket. Used
 * by Phase-1 incremental scanning: when a directory's mtime matches the
 * baseline, we inherit all files under it rather than re-walking.
 *
 * Returns a map from parent-directory path (normalized) to the file records
 * whose parent is that directory.
 */
export async function loadFilesByParent(
  filePath: string,
): Promise<Map<string, IndexRecord[]>> {
  const byParent = new Map<string, IndexRecord[]>();
  if (!FS.existsSync(filePath)) return byParent;

  const gunzip = createGunzip();
  const source = createReadStream(filePath);
  source.pipe(gunzip);

  const rl = createInterface({ input: gunzip, crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line) continue;
    try {
      const rec = JSON.parse(line) as IndexRecord;
      if (!rec || typeof rec.p !== "string" || rec.t === "d") continue;
      if (typeof rec.s !== "number") continue;
      const parent = normPath(Path.dirname(rec.p));
      let list = byParent.get(parent);
      if (!list) {
        list = [];
        byParent.set(parent, list);
      }
      list.push(rec);
    } catch { /* skip malformed lines */ }
  }
  return byParent;
}

/** Diff two indexes → FullDiffResult (sorted by absolute impact, capped at limit). */
export function diffIndexes(
  baselineId: string,
  currentId: string,
  baseline: Map<string, IndexRecord>,
  current: Map<string, IndexRecord>,
  limit: number = 500,
): FullDiffResult {
  const changes: FullFileChange[] = [];
  let totalAdded = 0;
  let totalRemoved = 0;
  let totalGrew = 0;
  let totalShrank = 0;
  let totalBytesAdded = 0;
  let totalBytesRemoved = 0;

  for (const [key, curr] of current) {
    const prev = baseline.get(key);
    if (!prev) {
      changes.push({
        path: curr.p,
        kind: "added",
        size: curr.s,
        previousSize: 0,
        deltaBytes: curr.s,
      });
      totalAdded++;
      totalBytesAdded += curr.s;
    } else if (curr.s !== prev.s) {
      const delta = curr.s - prev.s;
      if (delta > 0) {
        totalGrew++;
        totalBytesAdded += delta;
      } else {
        totalShrank++;
        totalBytesRemoved += -delta;
      }
      changes.push({
        path: curr.p,
        kind: delta > 0 ? "grew" : "shrank",
        size: curr.s,
        previousSize: prev.s,
        deltaBytes: delta,
      });
    }
  }

  for (const [key, prev] of baseline) {
    if (!current.has(key)) {
      changes.push({
        path: prev.p,
        kind: "removed",
        size: 0,
        previousSize: prev.s,
        deltaBytes: -prev.s,
      });
      totalRemoved++;
      totalBytesRemoved += prev.s;
    }
  }

  const totalChanges = changes.length;
  changes.sort((a, b) => Math.abs(b.deltaBytes) - Math.abs(a.deltaBytes));
  const truncated = totalChanges > limit;
  const capped = truncated ? changes.slice(0, limit) : changes;

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
    changes: capped,
    truncated,
  };
}

/**
 * Stream the index and return the N largest files by size, with an optional
 * minimum-size cutoff to skip noise. Keeps a bounded heap in memory so it
 * scales to tens of millions of files without loading them all.
 */
export async function loadLargestFiles(
  filePath: string,
  limit: number = 10_000,
  minBytes: number = 0,
): Promise<IndexRecord[]> {
  if (!FS.existsSync(filePath)) return [];

  const top: IndexRecord[] = [];
  let smallestInTop = 0;

  const gunzip = createGunzip();
  const source = createReadStream(filePath);
  source.pipe(gunzip);
  const rl = createInterface({ input: gunzip, crlfDelay: Infinity });

  for await (const line of rl) {
    if (!line) continue;
    let rec: IndexRecord;
    try {
      rec = JSON.parse(line) as IndexRecord;
    } catch { continue; }
    if (!rec || typeof rec.s !== "number" || rec.s < minBytes) continue;
    // Skip directory entries — they carry mtime only, no size.
    if (rec.t === "d") continue;

    if (top.length < limit) {
      top.push(rec);
      if (top.length === limit) {
        top.sort((a, b) => a.s - b.s);
        smallestInTop = top[0].s;
      }
    } else if (rec.s > smallestInTop) {
      // Replace the smallest entry (binary insertion keeps it sorted ascending)
      top[0] = rec;
      // Re-bubble down to maintain sorted order — simple re-sort is fine at this size
      top.sort((a, b) => a.s - b.s);
      smallestInTop = top[0].s;
    }
  }

  return top.sort((a, b) => b.s - a.s);
}

/**
 * Stream the index and return the direct children of `parentPath` with
 * their recursive sizes + file counts. Powers the Folders tab's drill-in
 * navigation without forcing the renderer to hold millions of file
 * records in memory.
 *
 * "Direct children" = for each file record under `parentPath`, either
 * (a) the file itself if its parent === parentPath, or (b) the name of
 * the folder one level deeper under parentPath, with size/count
 * aggregated across all files in that folder's subtree.
 *
 * Returns { dirs, files } — both capped at `dirLimit` / `fileLimit` by
 * largest size. Files array contains the top-N largest files directly
 * IN `parentPath` (not in any subfolder).
 *
 * Memory: O(number of direct children) + O(fileLimit). For a drive's
 * root this is typically dozens of dirs + the top few hundred files —
 * orders of magnitude less than the whole index.
 */
export async function loadDirectChildrenFromIndex(
  filePath: string,
  parentPath: string,
  dirLimit: number = 500,
  fileLimit: number = 500,
): Promise<{
  dirs: { path: string; size: number; fileCount: number }[];
  files: IndexRecord[];
}> {
  if (!FS.existsSync(filePath)) return { dirs: [], files: [] };

  // Normalize to a consistent separator + no trailing slash, then build
  // the "under parentPath" prefix we'll scan for.
  const parentNorm = normPath(parentPath).replace(/[\\/]+$/, "");
  const prefix = parentNorm.endsWith(":") ? parentNorm + Path.sep : parentNorm + Path.sep;

  const childDirTotals = new Map<string, { size: number; fileCount: number }>();
  const topFiles: IndexRecord[] = [];
  let smallestInTop = 0;

  const gunzip = createGunzip();
  const source = createReadStream(filePath);
  source.pipe(gunzip);
  const rl = createInterface({ input: gunzip, crlfDelay: Infinity });

  for await (const line of rl) {
    if (!line) continue;
    let rec: IndexRecord;
    try { rec = JSON.parse(line) as IndexRecord; } catch { continue; }
    if (!rec || typeof rec.p !== "string") continue;
    // Skip directory entries — they carry mtime only, no size, and we
    // roll up dirs from their file descendants anyway.
    if (rec.t === "d") continue;
    if (typeof rec.s !== "number") continue;

    const filePathNorm = normPath(rec.p);
    if (!filePathNorm.startsWith(prefix)) continue;

    const rest = filePathNorm.slice(prefix.length);
    const firstSep = rest.search(/[\\/]/);
    if (firstSep === -1) {
      // Direct file in parentPath — capture in top-N.
      if (topFiles.length < fileLimit) {
        topFiles.push(rec);
        if (topFiles.length === fileLimit) {
          topFiles.sort((a, b) => a.s - b.s);
          smallestInTop = topFiles[0].s;
        }
      } else if (rec.s > smallestInTop) {
        topFiles[0] = rec;
        topFiles.sort((a, b) => a.s - b.s);
        smallestInTop = topFiles[0].s;
      }
    } else {
      // Belongs to a child subfolder — roll up into that folder's totals.
      const childName = rest.slice(0, firstSep);
      const childPath = parentNorm + Path.sep + childName;
      const existing = childDirTotals.get(childPath);
      if (existing) {
        existing.size += rec.s;
        existing.fileCount += 1;
      } else {
        childDirTotals.set(childPath, { size: rec.s, fileCount: 1 });
      }
    }
  }

  const dirs = Array.from(childDirTotals.entries())
    .map(([path, totals]) => ({ path, size: totals.size, fileCount: totals.fileCount }))
    .sort((a, b) => b.size - a.size)
    .slice(0, dirLimit);

  return {
    dirs,
    files: topFiles.sort((a, b) => b.s - a.s),
  };
}

/** Delete an index file if it exists (best effort). */
export async function deleteIndex(id: string): Promise<void> {
  try {
    await FSP.unlink(indexFilePath(id));
  } catch { /* already gone */ }
  // Also drop the sidecar — no point keeping a folder-tree cache for
  // a scan whose index was just deleted.
  try {
    await FSP.unlink(folderTreeSidecarPath(id));
  } catch { /* sidecar optional / already gone */ }
}

// ── Snapshot reconstruction from index ─────────────────────────────────────

const TOP_FILE_LIMIT = 5_000;
const TOP_DIRECTORY_LIMIT = 10_000;
const TOP_EXTENSION_LIMIT = 12;

/** Parameters for reconstructing a snapshot from a persisted index file. */
export interface BuildSnapshotParams {
  indexPath: string;
  rootPath: string;
  engine: ScanEngine;
  startedAt: number;
  elapsedMs: number;
  errorMessage?: string | null;
}

/**
 * Stream a gzipped NDJSON index and produce a `ScanSnapshot` with aggregate
 * totals, top-N largest files, hottest directories, and extension buckets.
 *
 * Used primarily by the USN-journal incremental path: after applying deltas
 * to a new index, we call this to produce the snapshot the UI consumes. For
 * a 10M-file index it completes in single-digit seconds since it's a pure
 * linear stream with bounded-heap tracking.
 */
export async function buildSnapshotFromIndex(
  params: BuildSnapshotParams,
): Promise<ScanSnapshot> {
  const { indexPath, rootPath, engine, startedAt, elapsedMs } = params;

  let filesVisited = 0;
  let bytesSeen = 0;
  const directoryTotals = new Map<string, { size: number; count: number }>();
  const extensionTotals = new Map<string, { size: number; count: number }>();
  const largestFiles: ScanFileRecord[] = [];
  // Bounded heap semantics for largestFiles: keep up to TOP_FILE_LIMIT,
  // with a running "smallest size in the top" cursor for O(1) reject.
  let smallestInTop = 0;

  // Directory set: populated both from explicit {t:"d"} entries AND from
  // every unique parent directory encountered during the file walk. The
  // explicit-only approach used to drop to "1 dir" on incremental-update
  // indexes that lacked t:"d" entries; counting discovered parents as a
  // fallback keeps the Overview stat honest regardless of which scan
  // engine wrote the index.
  const directorySet = new Set<string>();

  const Path = await import("node:path");
  const rootNorm = Path.resolve(rootPath);

  if (!FS.existsSync(indexPath)) {
    return {
      ...createIdleScanSnapshot(),
      status: "done",
      engine,
      rootPath: rootNorm,
      startedAt,
      finishedAt: startedAt + elapsedMs,
      elapsedMs,
      filesVisited: 0,
      directoriesVisited: 0,
      skippedEntries: 0,
      bytesSeen: 0,
      largestFiles: [],
      hottestDirectories: [],
      topExtensions: [],
      errorMessage: params.errorMessage ?? null,
      lastUpdatedAt: Date.now(),
    };
  }

  const gunzip = createGunzip();
  const source = createReadStream(indexPath);
  source.pipe(gunzip);

  const rl = createInterface({ input: gunzip, crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line) continue;
    let rec: { p?: string; s?: number; m?: number; t?: string };
    try { rec = JSON.parse(line); } catch { continue; }
    if (!rec || typeof rec.p !== "string") continue;

    if (rec.t === "d") {
      directorySet.add(normPath(rec.p));
      continue;
    }

    if (typeof rec.s !== "number" || typeof rec.m !== "number") continue;

    // Skip files outside the scan root (defensive — index should be root-
    // scoped already, but the incremental path may leave cruft).
    const fileNorm = normPath(rec.p);
    if (!fileNorm.startsWith(normPath(rootNorm))) continue;

    filesVisited += 1;
    bytesSeen += rec.s;

    // Per-ancestor rollup: walk from parent dir up to root, adding this
    // file's bytes/count to each. Every unique ancestor also lands in
    // directorySet so the final directoriesVisited count reflects real
    // tree fan-out even when the persisted index skipped {t:"d"} rows.
    const name = Path.basename(rec.p);
    let parentPath = Path.dirname(rec.p);
    while (true) {
      const key = normPath(parentPath);
      directorySet.add(key);
      const entry = directoryTotals.get(key) ?? { size: 0, count: 0 };
      entry.size += rec.s;
      entry.count += 1;
      directoryTotals.set(key, entry);
      if (parentPath === rootNorm || key === normPath(rootNorm)) break;
      const next = Path.dirname(parentPath);
      if (next === parentPath) break;
      parentPath = next;
    }

    // Extension rollup
    const dotIdx = name.lastIndexOf(".");
    const extension = dotIdx > 0 ? name.slice(dotIdx).toLowerCase() : "(no ext)";
    const extEntry = extensionTotals.get(extension) ?? { size: 0, count: 0 };
    extEntry.size += rec.s;
    extEntry.count += 1;
    extensionTotals.set(extension, extEntry);

    // Top-N largest files with a bounded heap-like list.
    if (largestFiles.length < TOP_FILE_LIMIT) {
      largestFiles.push({
        path: rec.p,
        name,
        parentPath: Path.dirname(rec.p),
        extension,
        size: rec.s,
        modifiedAt: rec.m,
      });
      if (largestFiles.length === TOP_FILE_LIMIT) {
        largestFiles.sort((a, b) => a.size - b.size);
        smallestInTop = largestFiles[0].size;
      }
    } else if (rec.s > smallestInTop) {
      largestFiles[0] = {
        path: rec.p,
        name,
        parentPath: Path.dirname(rec.p),
        extension,
        size: rec.s,
        modifiedAt: rec.m,
      };
      largestFiles.sort((a, b) => a.size - b.size);
      smallestInTop = largestFiles[0].size;
    }
  }

  // Finalize: sort largest files descending, build hottestDirectories
  largestFiles.sort((a, b) => b.size - a.size);

  const hottestDirectories: DirectoryHotspot[] = Array.from(
    directoryTotals.entries(),
  )
    .map(([path, stats]) => {
      // Depth = number of separators below the root
      const rel = path.startsWith(normPath(rootNorm))
        ? path.slice(normPath(rootNorm).length).replace(/^[\\/]+/, "")
        : path;
      const depth = rel ? rel.split(/[\\/]+/).length : 0;
      return {
        path,
        size: stats.size,
        fileCount: stats.count,
        depth,
      };
    })
    .sort((a, b) => b.size - a.size)
    .slice(0, TOP_DIRECTORY_LIMIT);

  const topExtensions: ExtensionBucket[] = Array.from(extensionTotals.entries())
    .map(([extension, stats]) => ({
      extension,
      size: stats.size,
      count: stats.count,
    }))
    .sort((a, b) => b.size - a.size)
    .slice(0, TOP_EXTENSION_LIMIT);

  const finishedAt = startedAt + elapsedMs;

  return {
    ...createIdleScanSnapshot(),
    status: "done",
    engine,
    rootPath: rootNorm,
    startedAt,
    finishedAt,
    elapsedMs,
    filesVisited,
    directoriesVisited: directorySet.size,
    skippedEntries: 0,
    bytesSeen,
    largestFiles,
    hottestDirectories,
    topExtensions,
    errorMessage: params.errorMessage ?? null,
    lastUpdatedAt: Date.now(),
  };
}
