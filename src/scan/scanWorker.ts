import type { Dirent, Stats, WriteStream } from "node:fs";
import { createWriteStream, mkdirSync } from "node:fs";
import * as FS from "node:fs/promises";
import * as Path from "node:path";
import { createGzip } from "node:zlib";
import { parentPort } from "node:worker_threads";

import {
  createIdleScanSnapshot,
  type DirectoryHotspot,
  type ExtensionBucket,
  type MainToWorkerMessage,
  type ScanFileRecord,
  type ScanSnapshot,
} from "../shared/contracts";

const DEFAULT_TOP_FILE_LIMIT = 60;
const DEFAULT_TOP_DIRECTORY_LIMIT = 500;
const TOP_EXTENSION_LIMIT = 12;
const STAT_BATCH_SIZE = 32;
const SNAPSHOT_INTERVAL_MS = 200;
// Scan everything — no exclusion lists. A disk analyzer must be comprehensive.

// Guard: this module may get loaded outside a worker context
// (e.g. shared-chunk resolution during bundling). Only wire up
// the message handler when running as an actual Worker thread.
let cancelled = false;

if (parentPort) {
  parentPort.on("message", (message: MainToWorkerMessage | { type: "cancel" }) => {
    if (message.type === "cancel") {
      cancelled = true;
      return;
    }
    if (message.type !== "start") {
      return;
    }

    cancelled = false;
    void runScan(message.input).catch((error) => {
      parentPort?.postMessage({
        type: "error",
        message: error instanceof Error ? error.message : String(error),
      });
    });
  });
}

async function runScan(input: MainToWorkerMessage["input"]): Promise<void> {
  const rootPath = Path.resolve(input.rootPath);
  const scanOptions = input.options;
  const TOP_FILE_LIMIT = input.limits?.topFileLimit ?? DEFAULT_TOP_FILE_LIMIT;
  const TOP_DIRECTORY_LIMIT = input.limits?.topDirectoryLimit ?? DEFAULT_TOP_DIRECTORY_LIMIT;
  const startedAt = Date.now();
  const directoryTotals = new Map<string, DirectoryHotspot>();
  const extensionTotals = new Map<string, ExtensionBucket>();
  const largestFiles: ScanFileRecord[] = [];
  const hottestDirectories: DirectoryHotspot[] = [];
  const directoryStack = [rootPath];

  let filesVisited = 0;
  let directoriesVisited = 0;
  let skippedEntries = 0;
  let bytesSeen = 0;
  let lastEmitAt = 0;

  // Optional full-file index writer (gzipped NDJSON) for real diff tracking
  let indexGzip: ReturnType<typeof createGzip> | null = null;
  let indexFile: WriteStream | null = null;
  if (input.indexOutput) {
    try {
      mkdirSync(Path.dirname(input.indexOutput), { recursive: true });
      indexGzip = createGzip({ level: 6 });
      indexFile = createWriteStream(input.indexOutput);
      indexGzip.pipe(indexFile);
    } catch {
      indexGzip = null;
      indexFile = null;
    }
  }
  const writeIndexEntry = (path: string, size: number, mtime: number) => {
    if (!indexGzip) return;
    try {
      indexGzip.write(JSON.stringify({ p: path, s: size, m: mtime }) + "\n");
    } catch {
      indexGzip = null;
    }
  };
  const finalizeIndex = async () => {
    if (!indexGzip) return;
    await new Promise<void>((resolve) => {
      indexGzip!.end(() => resolve());
    });
    indexGzip = null;
    indexFile = null;
  };

  directoryTotals.set(rootPath, {
    path: rootPath,
    size: 0,
    fileCount: 0,
    depth: 0,
  });

  const emitSnapshot = (status: ScanSnapshot["status"], errorMessage: string | null = null) => {
    const now = Date.now();
    const snapshot: ScanSnapshot = {
      ...createIdleScanSnapshot(),
      status,
      engine: "js-worker",
      rootPath,
      scanOptions,
      startedAt,
      finishedAt: status === "done" || status === "error" || status === "cancelled" ? now : null,
      elapsedMs: now - startedAt,
      filesVisited,
      directoriesVisited,
      skippedEntries,
      bytesSeen,
      largestFiles: largestFiles.slice(0, TOP_FILE_LIMIT),
      hottestDirectories: hottestDirectories.slice(0, TOP_DIRECTORY_LIMIT),
      topExtensions: Array.from(extensionTotals.values())
        .sort((left, right) => right.size - left.size)
        .slice(0, TOP_EXTENSION_LIMIT),
      errorMessage,
      lastUpdatedAt: now,
    };

    parentPort?.postMessage({
      type: status === "done" || status === "cancelled" ? "done" : "progress",
      snapshot,
    });
  };

  while (directoryStack.length > 0) {
    if (cancelled) {
      await finalizeIndex();
      emitSnapshot("cancelled");
      return;
    }

    const directoryPath = directoryStack.pop();
    if (!directoryPath) {
      continue;
    }

    directoriesVisited += 1;

    let entries: Dirent[];
    try {
      entries = await FS.readdir(directoryPath, { withFileTypes: true });
    } catch {
      skippedEntries += 1;
      maybeEmitProgress();
      continue;
    }

    const fileEntries: Dirent[] = [];

    for (const entry of entries) {
      const fullPath = Path.join(directoryPath, entry.name);

      if (entry.isSymbolicLink()) {
        skippedEntries += 1;
        continue;
      }

      if (entry.isDirectory()) {
        if (!directoryTotals.has(fullPath)) {
          directoryTotals.set(fullPath, {
            path: fullPath,
            size: 0,
            fileCount: 0,
            depth: getDepth(rootPath, fullPath),
          });
        }
        directoryStack.push(fullPath);
        continue;
      }

      if (!entry.isFile()) {
        skippedEntries += 1;
        continue;
      }

      fileEntries.push(entry);
    }

    for (let index = 0; index < fileEntries.length; index += STAT_BATCH_SIZE) {
      const batch = fileEntries.slice(index, index + STAT_BATCH_SIZE);
      const batchResults = await Promise.all(
        batch.map(async (entry) => {
          const fullPath = Path.join(directoryPath, entry.name);
          let stat: Stats;
          try {
            stat = await FS.stat(fullPath);
          } catch {
            return null;
          }

          return {
            path: fullPath,
            name: entry.name,
            parentPath: directoryPath,
            extension: getExtension(entry.name),
            size: stat.size,
            modifiedAt: stat.mtimeMs,
          } satisfies ScanFileRecord;
        }),
      );

      for (const fileRecord of batchResults) {
        if (!fileRecord) {
          skippedEntries += 1;
          continue;
        }

        filesVisited += 1;
        bytesSeen += fileRecord.size;

        upsertRankedFile(largestFiles, fileRecord, TOP_FILE_LIMIT);
        rollupDirectorySize(rootPath, directoryPath, fileRecord.size, directoryTotals, hottestDirectories, TOP_DIRECTORY_LIMIT);
        rollupExtension(extensionTotals, fileRecord.extension, fileRecord.size);
        writeIndexEntry(fileRecord.path, fileRecord.size, fileRecord.modifiedAt);
        maybeEmitProgress();
      }
    }
  }

  await finalizeIndex();
  emitSnapshot("done");

  function maybeEmitProgress() {
    const now = Date.now();
    if (now - lastEmitAt < SNAPSHOT_INTERVAL_MS) {
      return;
    }

    lastEmitAt = now;
    emitSnapshot("running");
  }
}

function getExtension(fileName: string): string {
  const extension = Path.extname(fileName).trim().toLowerCase();
  return extension.length > 0 ? extension : "(no ext)";
}

function getDepth(rootPath: string, directoryPath: string): number {
  const relativePath = Path.relative(rootPath, directoryPath);
  if (!relativePath) {
    return 0;
  }

  return relativePath.split(Path.sep).length;
}

function upsertRankedFile(
  ranked: ScanFileRecord[],
  nextRecord: ScanFileRecord,
  limit: number,
): void {
  const existingIndex = ranked.findIndex((candidate) => candidate.path === nextRecord.path);
  if (existingIndex >= 0) {
    ranked.splice(existingIndex, 1);
  } else if (ranked.length >= limit && nextRecord.size <= ranked[ranked.length - 1].size) {
    return; // Too small to make the list
  }

  ranked.push(nextRecord);
  ranked.sort((left, right) => right.size - left.size);

  if (ranked.length > limit) {
    ranked.length = limit;
  }
}

function upsertRankedDirectory(
  ranked: DirectoryHotspot[],
  nextRecord: DirectoryHotspot,
  limit: number,
): void {
  const existingIndex = ranked.findIndex((candidate) => candidate.path === nextRecord.path);
  if (existingIndex >= 0) {
    ranked.splice(existingIndex, 1, { ...nextRecord });
  } else if (ranked.length >= limit && nextRecord.size <= ranked[ranked.length - 1].size) {
    return; // Too small to make the list
  } else {
    ranked.push({ ...nextRecord });
  }

  ranked.sort((left, right) => right.size - left.size);

  if (ranked.length > limit) {
    ranked.length = limit;
  }
}

function rollupDirectorySize(
  rootPath: string,
  directoryPath: string,
  fileSize: number,
  directoryTotals: Map<string, DirectoryHotspot>,
  hottestDirectories: DirectoryHotspot[],
  dirLimit: number,
): void {
  let currentPath = directoryPath;

  while (true) {
    const existing = directoryTotals.get(currentPath) ?? {
      path: currentPath,
      size: 0,
      fileCount: 0,
      depth: getDepth(rootPath, currentPath),
    };

    existing.size += fileSize;
    existing.fileCount += 1;
    directoryTotals.set(currentPath, existing);
    upsertRankedDirectory(hottestDirectories, existing, dirLimit);

    if (currentPath === rootPath) {
      return;
    }

    const parentPath = Path.dirname(currentPath);
    if (parentPath === currentPath) {
      return;
    }

    currentPath = parentPath;
  }
}

function rollupExtension(
  extensionTotals: Map<string, ExtensionBucket>,
  extension: string,
  fileSize: number,
): void {
  const existing = extensionTotals.get(extension) ?? {
    extension,
    size: 0,
    count: 0,
  };

  existing.size += fileSize;
  existing.count += 1;
  extensionTotals.set(extension, existing);
}
