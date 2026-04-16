import type {
  DirectoryDelta,
  ExtensionDelta,
  FileDelta,
  ScanDiffResult,
  ScanSnapshot,
} from "./contracts";
import { normPath } from "./pathUtils";

/**
 * Compute the diff between two scan snapshots.
 *
 * Aggregate totals (bytesSeen, filesVisited, directoriesVisited) are reliable
 * because they sum ALL files/dirs the scanner encountered.
 *
 * Itemized file/directory deltas are limited to whatever was in the top-N
 * ranked lists. A file disappearing from the list may mean it was deleted OR
 * it was pushed out by a larger file. The UI should communicate this.
 */
export function computeDiff(
  baseline: ScanSnapshot,
  current: ScanSnapshot,
  baselineId: string,
  currentId: string,
): ScanDiffResult {
  const rootPath = current.rootPath ?? baseline.rootPath ?? "";

  return {
    baselineId,
    baselineScannedAt: baseline.finishedAt ?? baseline.startedAt ?? 0,
    currentId,
    currentScannedAt: current.finishedAt ?? current.startedAt ?? 0,
    rootPath,

    // ── Aggregates ──
    totalBytesDelta: current.bytesSeen - baseline.bytesSeen,
    totalFilesDelta: current.filesVisited - baseline.filesVisited,
    totalDirsDelta: current.directoriesVisited - baseline.directoriesVisited,
    previousBytesSeen: baseline.bytesSeen,
    currentBytesSeen: current.bytesSeen,

    // ── Itemized ──
    fileDeltas: diffFiles(baseline, current),
    directoryDeltas: diffDirectories(baseline, current),
    extensionDeltas: diffExtensions(baseline, current),

    timeBetweenMs: (current.finishedAt ?? 0) - (baseline.finishedAt ?? 0),
  };
}

function diffFiles(baseline: ScanSnapshot, current: ScanSnapshot): FileDelta[] {
  const oldMap = new Map(baseline.largestFiles.map((f) => [normPath(f.path), f]));
  const newMap = new Map(current.largestFiles.map((f) => [normPath(f.path), f]));
  const deltas: FileDelta[] = [];

  // Files in current scan
  for (const [key, file] of newMap) {
    const old = oldMap.get(key);
    if (!old) {
      deltas.push({
        path: file.path,
        name: file.name,
        extension: file.extension,
        kind: "added",
        size: file.size,
        previousSize: 0,
        deltaBytes: file.size,
      });
    } else if (file.size !== old.size) {
      deltas.push({
        path: file.path,
        name: file.name,
        extension: file.extension,
        kind: file.size > old.size ? "grew" : "shrank",
        size: file.size,
        previousSize: old.size,
        deltaBytes: file.size - old.size,
      });
    }
  }

  // Files that were in baseline but not in current
  for (const [key, file] of oldMap) {
    if (!newMap.has(key)) {
      deltas.push({
        path: file.path,
        name: file.name,
        extension: file.extension,
        kind: "removed",
        size: 0,
        previousSize: file.size,
        deltaBytes: -file.size,
      });
    }
  }

  // Sort by absolute impact (largest changes first)
  deltas.sort((a, b) => Math.abs(b.deltaBytes) - Math.abs(a.deltaBytes));
  return deltas;
}

function diffDirectories(baseline: ScanSnapshot, current: ScanSnapshot): DirectoryDelta[] {
  const oldMap = new Map(baseline.hottestDirectories.map((d) => [normPath(d.path), d]));
  const newMap = new Map(current.hottestDirectories.map((d) => [normPath(d.path), d]));
  const deltas: DirectoryDelta[] = [];

  for (const [key, dir] of newMap) {
    const old = oldMap.get(key);
    if (!old) {
      deltas.push({
        path: dir.path,
        kind: "added",
        size: dir.size,
        previousSize: 0,
        deltaBytes: dir.size,
        fileCount: dir.fileCount,
        previousFileCount: 0,
      });
    } else if (dir.size !== old.size) {
      deltas.push({
        path: dir.path,
        kind: dir.size > old.size ? "grew" : "shrank",
        size: dir.size,
        previousSize: old.size,
        deltaBytes: dir.size - old.size,
        fileCount: dir.fileCount,
        previousFileCount: old.fileCount,
      });
    }
  }

  for (const [key, dir] of oldMap) {
    if (!newMap.has(key)) {
      deltas.push({
        path: dir.path,
        kind: "removed",
        size: 0,
        previousSize: dir.size,
        deltaBytes: -dir.size,
        fileCount: 0,
        previousFileCount: dir.fileCount,
      });
    }
  }

  deltas.sort((a, b) => Math.abs(b.deltaBytes) - Math.abs(a.deltaBytes));
  return deltas;
}

function diffExtensions(baseline: ScanSnapshot, current: ScanSnapshot): ExtensionDelta[] {
  const oldMap = new Map(baseline.topExtensions.map((e) => [e.extension, e]));
  const newMap = new Map(current.topExtensions.map((e) => [e.extension, e]));
  const deltas: ExtensionDelta[] = [];
  const seen = new Set<string>();

  for (const [ext, bucket] of newMap) {
    seen.add(ext);
    const old = oldMap.get(ext);
    const prev = old ?? { size: 0, count: 0 };
    if (bucket.size !== prev.size) {
      deltas.push({
        extension: ext,
        size: bucket.size,
        previousSize: prev.size,
        deltaBytes: bucket.size - prev.size,
        count: bucket.count,
        previousCount: prev.count,
      });
    }
  }

  for (const [ext, bucket] of oldMap) {
    if (!seen.has(ext)) {
      deltas.push({
        extension: ext,
        size: 0,
        previousSize: bucket.size,
        deltaBytes: -bucket.size,
        count: 0,
        previousCount: bucket.count,
      });
    }
  }

  deltas.sort((a, b) => Math.abs(b.deltaBytes) - Math.abs(a.deltaBytes));
  return deltas;
}

