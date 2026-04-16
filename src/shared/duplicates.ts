import * as FS from "node:fs";
import * as FSP from "node:fs/promises";
import * as Path from "node:path";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";

import type {
  DuplicateAnalysis,
  DuplicateFileEntry,
  DuplicateGroup,
  DuplicateScanProgress,
} from "./contracts";

const PROGRESS_INTERVAL_MS = 200;
const PREFIX_BYTES = 4096;
const HASH_CONCURRENCY = 8;

export interface DuplicateScanCallbacks {
  onProgress: (progress: DuplicateScanProgress) => void;
  onResult: (result: DuplicateAnalysis) => void;
  onError: (error: Error) => void;
}

export interface DuplicateScanHandle {
  cancel: () => void;
}

interface FileCandidate {
  path: string;
  name: string;
  parentPath: string;
  modifiedAt: number;
}

export function runDuplicateScan(
  rootPath: string,
  callbacks: DuplicateScanCallbacks,
): DuplicateScanHandle {
  let cancelled = false;
  const startedAt = Date.now();

  let filesWalked = 0;
  let candidateGroups = 0;
  let filesHashed = 0;
  let groupsConfirmed = 0;
  let lastEmitAt = 0;

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
    });
  };

  const run = async () => {
    // ── Phase 1: Walk filesystem and group by size ──
    const sizeMap = new Map<number, FileCandidate[]>();
    const directoryStack = [Path.resolve(rootPath)];

    emitProgress("walking", true);

    while (directoryStack.length > 0) {
      if (cancelled) return;

      const dirPath = directoryStack.pop()!;
      let entries: FS.Dirent[];
      try {
        entries = await FSP.readdir(dirPath, { withFileTypes: true });
      } catch {
        continue; // permission denied, etc.
      }

      for (const entry of entries) {
        if (cancelled) return;
        const fullPath = Path.join(dirPath, entry.name);

        if (entry.isSymbolicLink()) continue;
        if (entry.isDirectory()) {
          directoryStack.push(fullPath);
          continue;
        }
        if (!entry.isFile()) continue;

        let stat: FS.Stats;
        try {
          stat = await FSP.stat(fullPath);
        } catch {
          continue;
        }

        // Skip empty files (all are trivially "identical")
        if (stat.size === 0) continue;

        filesWalked++;

        const candidate: FileCandidate = {
          path: fullPath,
          name: entry.name,
          parentPath: dirPath,
          modifiedAt: stat.mtimeMs,
        };

        const group = sizeMap.get(stat.size);
        if (group) {
          if (group.length === 1) candidateGroups++; // just became a candidate
          group.push(candidate);
        } else {
          sizeMap.set(stat.size, [candidate]);
        }

        emitProgress("walking");
      }
    }

    if (cancelled) return;
    emitProgress("walking", true);

    // ── Phase 2: Hash candidates ──
    // Only process size groups with 2+ files
    const candidateEntries: [number, FileCandidate[]][] = [];
    for (const [size, files] of sizeMap) {
      if (files.length >= 2) {
        candidateEntries.push([size, files]);
      }
    }
    // Process largest groups first (most potential space savings)
    candidateEntries.sort((a, b) => b[0] * b[1].length - a[0] * a[1].length);

    const confirmedGroups: DuplicateGroup[] = [];
    emitProgress("hashing", true);

    for (const [size, files] of candidateEntries) {
      if (cancelled) return;

      // Pass A: prefix hash (first 4KB) for fast rejection — batched concurrently
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
          if (!prefixHash) continue; // file vanished or unreadable

          const bucket = prefixMap.get(prefixHash);
          if (bucket) {
            bucket.push(file);
          } else {
            prefixMap.set(prefixHash, [file]);
          }
        }
        emitProgress("hashing");
      }

      // Pass B: full hash for prefix-matched groups
      for (const [, prefixGroup] of prefixMap) {
        if (prefixGroup.length < 2) continue;
        if (cancelled) return;

        // For small files (≤ prefix size), the prefix hash IS the full hash
        if (size <= PREFIX_BYTES) {
          confirmedGroups.push({
            hash: await hashFileFull(prefixGroup[0].path) ?? "prefix",
            size,
            files: prefixGroup.map(toEntry),
          });
          groupsConfirmed++;
          emitProgress("hashing");
          continue;
        }

        // Full hash needed — batched concurrently
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
            if (bucket) {
              bucket.push(file);
            } else {
              fullMap.set(fullHash, [file]);
            }
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

    // Sort by wasted space descending
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

// ── Hashing helpers ────────────────────────────────────────

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
  return {
    path: c.path,
    name: c.name,
    parentPath: c.parentPath,
    modifiedAt: c.modifiedAt,
  };
}
