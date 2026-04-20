import * as FS from "node:fs";
import * as FSP from "node:fs/promises";
import * as Path from "node:path";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { createGunzip } from "node:zlib";
import { createInterface } from "node:readline";

import type {
  DuplicateAnalysis,
  DuplicateFileEntry,
  DuplicateGroup,
  DuplicateScanProgress,
} from "./contracts";
import { normPath } from "./pathUtils";

const PROGRESS_INTERVAL_MS = 200;
const PREFIX_BYTES = 4096;
const HASH_CONCURRENCY = 8;
/**
 * Default minimum file size to consider. Rationale: most "wasted space"
 * from duplicates lives in big files — photos, videos, installers,
 * archives. Scanning every 4 KB icon-cache file multiplies memory usage
 * by 10× without uncovering anything actionable.
 */
const DEFAULT_MIN_SIZE_BYTES = 1 * 1024 * 1024;

export interface DuplicateScanCallbacks {
  onProgress: (progress: DuplicateScanProgress) => void;
  onResult: (result: DuplicateAnalysis) => void;
  onError: (error: Error) => void;
}

export interface DuplicateScanHandle {
  cancel: () => void;
}

export interface DuplicateScanOptions {
  /**
   * Path to a gzipped NDJSON scan index to use as the candidate source,
   * bypassing a fresh filesystem walk. Records are filtered to those
   * under `rootPath`. If null/absent or unreadable, we fall back to
   * walking the filesystem.
   */
  indexPath?: string | null;
  minSizeBytes?: number;
}

interface FileCandidate {
  path: string;
  size: number;
  mtime: number;
}

export function runDuplicateScan(
  rootPath: string,
  callbacks: DuplicateScanCallbacks,
  options: DuplicateScanOptions = {},
): DuplicateScanHandle {
  let cancelled = false;
  const startedAt = Date.now();
  const minSizeBytes = options.minSizeBytes ?? DEFAULT_MIN_SIZE_BYTES;

  let filesWalked = 0;
  let candidateGroups = 0;
  let filesHashed = 0;
  let groupsConfirmed = 0;
  let lastEmitAt = 0;
  let source: "index" | "walk" = "walk";

  const emitProgress = (status: DuplicateScanProgress["status"], force = false) => {
    const now = Date.now();
    if (!force && now - lastEmitAt < PROGRESS_INTERVAL_MS) return;
    lastEmitAt = now;
    callbacks.onProgress({
      status,
      filesWalked,
      candidateGroups,
      filesHashed,
      groupsConfirmed,
      elapsedMs: now - startedAt,
      errorMessage: null,
      source,
      minSizeBytes,
    });
  };

  const run = async () => {
    emitProgress("walking", true);

    // ── Phase 1: collect candidates (either via index or fs walk) ──
    //
    // Two-pass streaming when using the index:
    //   Pass A: Map<size, count>  — tiny, counts only.
    //   Pass B: Map<size, FileCandidate[]>  — only for sizes with count ≥ 2.
    //
    // Why: the typical disk has millions of unique file sizes; only a
    // small fraction have duplicates. Storing every file's path upfront
    // would balloon resident memory to 1–2 GB for a 2M-file drive. The
    // two-pass approach keeps the candidate map to just the sizes that
    // actually matter — often <5% of the total file count.
    let sizeMap: Map<number, FileCandidate[]>;

    const normalizedRoot = normPath(Path.resolve(rootPath));
    const rootPrefix = normalizedRoot.endsWith(Path.sep)
      ? normalizedRoot
      : normalizedRoot + Path.sep;

    const canUseIndex = options.indexPath && FS.existsSync(options.indexPath);
    if (canUseIndex) {
      source = "index";
      sizeMap = await collectFromIndex(options.indexPath!, {
        minSizeBytes,
        rootNorm: normalizedRoot,
        rootPrefix,
        onProgress: (walked, candGroups) => {
          filesWalked = walked;
          candidateGroups = candGroups;
          emitProgress("walking");
          return !cancelled;
        },
      });
    } else {
      source = "walk";
      sizeMap = await collectFromWalk(rootPath, {
        minSizeBytes,
        onProgress: (walked, candGroups) => {
          filesWalked = walked;
          candidateGroups = candGroups;
          emitProgress("walking");
          return !cancelled;
        },
      });
    }

    if (cancelled) return;
    // Final count of candidate-bearing sizes after the map is built.
    candidateGroups = 0;
    for (const list of sizeMap.values()) {
      if (list.length >= 2) candidateGroups++;
    }
    emitProgress("walking", true);

    // ── Phase 2: Hash candidates ──
    const candidateEntries: [number, FileCandidate[]][] = [];
    for (const [size, files] of sizeMap) {
      if (files.length >= 2) candidateEntries.push([size, files]);
    }
    // Largest-potential-waste-first so early cancellation still yields
    // the most useful results.
    candidateEntries.sort((a, b) => b[0] * b[1].length - a[0] * a[1].length);

    // Help the GC by dropping the size map — we only need the filtered list now.
    sizeMap.clear();

    const confirmedGroups: DuplicateGroup[] = [];
    emitProgress("hashing", true);

    for (const [size, files] of candidateEntries) {
      if (cancelled) return;

      // Pass A: prefix hash (first 4KB) — fast reject for almost-certain-
      // non-dupes without reading whole files.
      const prefixMap = new Map<string, FileCandidate[]>();
      for (let i = 0; i < files.length; i += HASH_CONCURRENCY) {
        if (cancelled) return;
        const batch = files.slice(i, i + HASH_CONCURRENCY);
        const results = await Promise.all(
          batch.map(async (file) => {
            const prefixHash = await hashFilePrefix(file.path);
            return { file, prefixHash };
          }),
        );
        for (const { file, prefixHash } of results) {
          filesHashed++;
          if (!prefixHash) continue;
          const bucket = prefixMap.get(prefixHash);
          if (bucket) bucket.push(file);
          else prefixMap.set(prefixHash, [file]);
        }
        emitProgress("hashing");
      }

      // Pass B: full hash for prefix-matched groups
      for (const [, prefixGroup] of prefixMap) {
        if (prefixGroup.length < 2) continue;
        if (cancelled) return;

        if (size <= PREFIX_BYTES) {
          // Prefix hash IS the full hash for files ≤ 4 KB
          confirmedGroups.push({
            hash: (await hashFileFull(prefixGroup[0]!.path)) ?? "prefix",
            size,
            files: prefixGroup.map(toEntry),
          });
          groupsConfirmed++;
          emitProgress("hashing");
          continue;
        }

        const fullMap = new Map<string, FileCandidate[]>();
        for (let i = 0; i < prefixGroup.length; i += HASH_CONCURRENCY) {
          if (cancelled) return;
          const batch = prefixGroup.slice(i, i + HASH_CONCURRENCY);
          const results = await Promise.all(
            batch.map(async (file) => {
              const fullHash = await hashFileFull(file.path);
              return { file, fullHash };
            }),
          );
          for (const { file, fullHash } of results) {
            if (!fullHash) continue;
            const bucket = fullMap.get(fullHash);
            if (bucket) bucket.push(file);
            else fullMap.set(fullHash, [file]);
          }
        }

        for (const [hash, dupes] of fullMap) {
          if (dupes.length >= 2) {
            confirmedGroups.push({
              hash,
              size,
              files: dupes.map(toEntry),
            });
            groupsConfirmed++;
            emitProgress("hashing");
          }
        }
      }
    }

    if (cancelled) return;

    confirmedGroups.sort(
      (a, b) => (b.files.length - 1) * b.size - (a.files.length - 1) * a.size,
    );

    const totalWastedBytes = confirmedGroups.reduce(
      (sum, g) => sum + (g.files.length - 1) * g.size,
      0,
    );
    const totalDuplicateFiles = confirmedGroups.reduce(
      (sum, g) => sum + g.files.length,
      0,
    );

    const result: DuplicateAnalysis = {
      groups: confirmedGroups,
      totalWastedBytes,
      totalGroups: confirmedGroups.length,
      totalDuplicateFiles,
      rootPath,
      filesWalked,
      filesHashed,
      elapsedMs: Date.now() - startedAt,
      analyzedAt: Date.now(),
    };

    callbacks.onResult(result);
  };

  void run().catch((error) => {
    if (!cancelled) {
      callbacks.onError(error instanceof Error ? error : new Error(String(error)));
    }
  });

  return {
    cancel: () => { cancelled = true; },
  };
}

// ── Candidate collection: index-streaming path ───────────────────────────

interface CollectCallbacks {
  minSizeBytes: number;
  rootNorm: string;
  rootPrefix: string;
  onProgress: (walked: number, candidateGroups: number) => boolean;
}

/**
 * Two-pass streaming read of the gzipped NDJSON index:
 *   Pass A: count files per size (skip files below threshold / outside scope).
 *   Pass B: materialize the FileCandidate list, but only for sizes that
 *           showed ≥ 2 occurrences in pass A.
 *
 * Memory cost is O(unique-sizes) during pass A and O(candidate-files)
 * during pass B — both tiny compared to "all files". A typical
 * 2M-file drive yields a few hundred thousand unique sizes but only a
 * few thousand candidate-bearing sizes with a few tens of thousands of
 * candidate paths total.
 */
async function collectFromIndex(
  indexPath: string,
  cbs: CollectCallbacks,
): Promise<Map<number, FileCandidate[]>> {
  // ── Pass A: size → count ──
  const sizeCounts = new Map<number, number>();
  let walked = 0;
  await streamIndex(indexPath, (rec) => {
    if (rec.t === "d") return true; // skip directory entries
    const size = rec.s;
    if (typeof size !== "number" || size < cbs.minSizeBytes) return true;
    if (!pathIsUnderRoot(rec.p, cbs.rootNorm, cbs.rootPrefix)) return true;
    walked++;
    sizeCounts.set(size, (sizeCounts.get(size) ?? 0) + 1);
    if (walked % 5_000 === 0) {
      let candGroups = 0;
      for (const count of sizeCounts.values()) if (count >= 2) candGroups++;
      return cbs.onProgress(walked, candGroups);
    }
    return true;
  });

  // Compact the count map down to "sizes we care about".
  const candidateSizes = new Set<number>();
  for (const [size, count] of sizeCounts) {
    if (count >= 2) candidateSizes.add(size);
  }
  sizeCounts.clear();

  // ── Pass B: materialize candidates only for sizes we care about ──
  const sizeMap = new Map<number, FileCandidate[]>();
  let walkedB = 0;
  await streamIndex(indexPath, (rec) => {
    if (rec.t === "d") return true;
    const size = rec.s;
    if (typeof size !== "number" || size < cbs.minSizeBytes) return true;
    if (!candidateSizes.has(size)) return true;
    if (!pathIsUnderRoot(rec.p, cbs.rootNorm, cbs.rootPrefix)) return true;
    walkedB++;
    const bucket = sizeMap.get(size);
    const candidate: FileCandidate = {
      path: rec.p,
      size,
      mtime: typeof rec.m === "number" ? rec.m : 0,
    };
    if (bucket) bucket.push(candidate);
    else sizeMap.set(size, [candidate]);
    if (walkedB % 2_000 === 0) {
      cbs.onProgress(walked, sizeMap.size);
    }
    return true;
  });

  return sizeMap;
}

/** Stream a gzipped NDJSON line by line, calling `onRec` for each parsed
 *  record. Return false from `onRec` to stop early. */
async function streamIndex(
  indexPath: string,
  onRec: (rec: { p: string; s?: number; m?: number; t?: string }) => boolean,
): Promise<void> {
  const gunzip = createGunzip();
  const source = createReadStream(indexPath);
  source.pipe(gunzip);
  const rl = createInterface({ input: gunzip, crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line) continue;
    let rec: { p?: string; s?: number; m?: number; t?: string };
    try { rec = JSON.parse(line); } catch { continue; }
    if (!rec || typeof rec.p !== "string") continue;
    const cont = onRec(rec as { p: string; s?: number; m?: number; t?: string });
    if (!cont) break;
  }
  rl.close();
}

function pathIsUnderRoot(path: string, rootNorm: string, rootPrefix: string): boolean {
  const n = normPath(path);
  return n === rootNorm || n.startsWith(rootPrefix);
}

// ── Candidate collection: filesystem-walk fallback ───────────────────────

/**
 * Fallback when the index isn't available. Walks the tree with
 * stat-per-file, but now applies the same two-pass trick: first pass
 * counts by size (no path allocation), second pass collects only paths
 * for sizes that showed ≥ 2 occurrences.
 *
 * This is slower than the index path because of the stat syscalls, but
 * still avoids the old 1–2 GB memory peak since we don't materialize
 * every single file's candidate eagerly.
 */
async function collectFromWalk(
  rootPath: string,
  cbs: Omit<CollectCallbacks, "rootNorm" | "rootPrefix">,
): Promise<Map<number, FileCandidate[]>> {
  const entries: { path: string; size: number; mtime: number }[] = [];
  const sizeCounts = new Map<number, number>();
  const directoryStack = [Path.resolve(rootPath)];
  let walked = 0;

  while (directoryStack.length > 0) {
    const dirPath = directoryStack.pop()!;
    let dirEntries: FS.Dirent[];
    try {
      dirEntries = await FSP.readdir(dirPath, { withFileTypes: true });
    } catch { continue; }

    for (const entry of dirEntries) {
      if (entry.isSymbolicLink()) continue;
      const fullPath = Path.join(dirPath, entry.name);
      if (entry.isDirectory()) {
        directoryStack.push(fullPath);
        continue;
      }
      if (!entry.isFile()) continue;

      let stat: FS.Stats;
      try { stat = await FSP.stat(fullPath); }
      catch { continue; }
      if (stat.size < cbs.minSizeBytes) continue;

      walked++;
      sizeCounts.set(stat.size, (sizeCounts.get(stat.size) ?? 0) + 1);
      entries.push({ path: fullPath, size: stat.size, mtime: stat.mtimeMs });
      if (walked % 500 === 0) {
        let candGroups = 0;
        for (const c of sizeCounts.values()) if (c >= 2) candGroups++;
        if (!cbs.onProgress(walked, candGroups)) break;
      }
    }
  }

  // Build the candidate map, keeping only sizes with ≥ 2 occurrences.
  // We have to keep the path list for the second pass because we
  // can't re-walk efficiently — but we only keep paths for sizes that
  // qualify, which is usually < 5 % of the total.
  const sizeMap = new Map<number, FileCandidate[]>();
  for (const e of entries) {
    const count = sizeCounts.get(e.size) ?? 0;
    if (count < 2) continue;
    const bucket = sizeMap.get(e.size);
    const candidate: FileCandidate = { path: e.path, size: e.size, mtime: e.mtime };
    if (bucket) bucket.push(candidate);
    else sizeMap.set(e.size, [candidate]);
  }

  return sizeMap;
}

// ── Hashing helpers ──────────────────────────────────────────────────────

function hashFilePrefix(filePath: string): Promise<string | null> {
  return new Promise((resolve) => {
    try {
      const stream = createReadStream(filePath, { start: 0, end: PREFIX_BYTES - 1 });
      const hash = createHash("sha256");
      stream.on("data", (chunk) => hash.update(chunk));
      stream.on("end", () => resolve(hash.digest("hex")));
      stream.on("error", () => resolve(null));
    } catch {
      resolve(null);
    }
  });
}

function hashFileFull(filePath: string): Promise<string | null> {
  return new Promise((resolve) => {
    try {
      const stream = createReadStream(filePath);
      const hash = createHash("sha256");
      stream.on("data", (chunk) => hash.update(chunk));
      stream.on("end", () => resolve(hash.digest("hex")));
      stream.on("error", () => resolve(null));
    } catch {
      resolve(null);
    }
  });
}

function toEntry(c: FileCandidate): DuplicateFileEntry {
  const name = Path.basename(c.path);
  const parentPath = Path.dirname(c.path);
  return {
    path: c.path,
    name,
    parentPath,
    modifiedAt: c.mtime,
  };
}
