import * as Path from "node:path";
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { Worker } from "node:worker_threads";
import { createGunzip } from "node:zlib";

import { normPath } from "./pathUtils";
import type {
  CompactFolderFileRecord,
  FolderTreeWorkerInput,
  FolderTreeWorkerRequest,
  FolderTreeWorkerResponse,
  SerializedFolderTree,
} from "./folderTreeWorkerProtocol";

const FILES_PER_FOLDER = 200;
const DIRS_PER_FOLDER = 500;

/**
 * Build a full parent → children map by streaming the completed scan
 * index once. Moved out of main.ts so it can run inside a Node worker
 * thread — on drive-scale scans (7M+ files) the per-line JSON.parse +
 * Map churn saturates the event loop for ~5 minutes and blocks every
 * setInterval / IPC handler on the main thread.
 *
 * Logic is intentionally identical to the prior inline implementation;
 * see main.ts history for design notes on the bounded-heap trim + key
 * normalization (normalized, no trailing separator).
 */
export async function buildFolderTreeFromIndex(
  indexPathStr: string,
): Promise<SerializedFolderTree> {
  type DirTotals = Map<string, { size: number; fileCount: number }>;
  const childDirTotalsByParent = new Map<string, DirTotals>();
  const filesByParent = new Map<string, CompactFolderFileRecord[]>();

  const toKey = (p: string): string => normPath(p).replace(/[\\/]+$/, "");

  const gunzip = createGunzip();
  const source = createReadStream(indexPathStr);
  source.pipe(gunzip);
  const rl = createInterface({ input: gunzip, crlfDelay: Infinity });

  // Fast-path regex for file entries: the scanner always emits exactly
  // this shape, so pattern-matching it bypasses serde_json's object
  // allocation and the two .indexOf() calls JSON.parse does internally.
  // Format: {"p":"<escapedPath>","s":<size>,"m":<mtime>}
  // (dir entries use "t":"d" and are skipped cheaply below.)
  const FILE_LINE_RE = /^\{"p":"((?:\\.|[^"\\])*)","s":(\d+),"m":(\d+)\}$/;

  for await (const line of rl) {
    if (!line) continue;
    // Dir entries: skip without parsing. Using indexOf on a fixed
    // substring is ~30× faster than JSON.parse for the ~15% of lines
    // that carry no file data. The `"t":"d"` marker is unique to dir
    // records so a substring match is unambiguous.
    if (line.indexOf('"t":"d"') !== -1) continue;

    // Fast path — regex match on the canonical shape. Backslash
    // unescape happens on the captured path string (Windows paths have
    // `\\` for every separator).
    let rawPath: string;
    let size: number;
    let mtime: number;
    const fastMatch = FILE_LINE_RE.exec(line);
    if (fastMatch) {
      // Unescape only if we see a backslash — ~70% of lines have them
      // (Windows paths), but the check is one indexOf either way.
      rawPath = fastMatch[1].indexOf("\\") === -1
        ? fastMatch[1]
        : fastMatch[1].replace(/\\\\/g, "\\").replace(/\\"/g, '"');
      size = Number(fastMatch[2]);
      mtime = Number(fastMatch[3]);
    } else {
      // Slow fallback: line has unusual escapes or field ordering.
      let rec: { p?: string; s?: number; t?: string; m?: number };
      try {
        rec = JSON.parse(line);
      } catch {
        continue;
      }
      if (!rec || typeof rec.p !== "string") continue;
      if (rec.t === "d") continue;
      if (typeof rec.s !== "number") continue;
      rawPath = rec.p;
      size = rec.s;
      mtime = typeof rec.m === "number" ? rec.m : 0;
    }

    const filePathNorm = toKey(rawPath);

    let current = toKey(Path.dirname(filePathNorm));
    let prevChild = filePathNorm;
    const directParent = toKey(Path.dirname(filePathNorm));
    while (true) {
      const parent = current;
      if (prevChild === filePathNorm && parent === directParent) {
        let list = filesByParent.get(parent);
        if (!list) {
          list = [];
          filesByParent.set(parent, list);
        }
        list.push({
          name: Path.basename(filePathNorm),
          size,
          modifiedAt: mtime,
        });
        if (list.length > FILES_PER_FOLDER * 2) {
          list.sort((a, b) => b.size - a.size);
          list.length = FILES_PER_FOLDER;
        }
      } else if (prevChild !== filePathNorm) {
        let totals = childDirTotalsByParent.get(parent);
        if (!totals) {
          totals = new Map();
          childDirTotalsByParent.set(parent, totals);
        }
        const cur = totals.get(prevChild);
        if (cur) {
          cur.size += size;
          cur.fileCount += 1;
        } else {
          totals.set(prevChild, { size, fileCount: 1 });
        }
      }

      const grandparent = toKey(Path.dirname(parent));
      if (grandparent === parent || grandparent === "") break;
      prevChild = parent;
      current = grandparent;
    }
  }

  const tree: SerializedFolderTree = [];
  const allKeys = new Set<string>();
  for (const k of childDirTotalsByParent.keys()) allKeys.add(k);
  for (const k of filesByParent.keys()) allKeys.add(k);
  for (const parent of allKeys) {
    const dirTotals = childDirTotalsByParent.get(parent);
    const dirs = dirTotals
      ? Array.from(dirTotals.entries())
          .map(([path, t]) => ({ path, size: t.size, fileCount: t.fileCount }))
          .sort((a, b) => b.size - a.size)
          .slice(0, DIRS_PER_FOLDER)
      : [];
    const rawFiles = filesByParent.get(parent) ?? [];
    const files = rawFiles
      .sort((a, b) => b.size - a.size)
      .slice(0, FILES_PER_FOLDER);
    tree.push([parent, { dirs, files }]);
  }
  return tree;
}

export function resolveBundledFolderTreeWorkerPath(baseDir: string): string {
  return Path.join(baseDir, "scan", "folderTreeWorker.cjs");
}

export interface RunFolderTreeWorkerOptions {
  workerPath: string;
  signal?: AbortSignal;
}

export async function runFolderTreeWorker(
  input: FolderTreeWorkerInput,
  options: RunFolderTreeWorkerOptions,
): Promise<SerializedFolderTree> {
  // 8 GB old-gen ceiling. The MFT fast path emits a ~25% larger record
  // set than the walker because it expands hardlinks and recovers
  // extension-record $DATA that the walker couldn't see — on a 7M-file
  // C:\ that works out to ~8.3M entries, which pushes the worker's
  // working set past 4 GB. 0.4.x shipped with 8 GB but user reports
  // still hit OOM on drives where baseline + scan index combined push
  // the worker past 8 GB during tree assembly. 12 GB gives room for
  // the tree Map + the streaming JSON.parse temp allocations on the
  // largest realistic drives. Reserved pages don't commit until
  // touched, so this costs nothing on small scans.
  const worker = new Worker(options.workerPath, {
    resourceLimits: {
      maxOldGenerationSizeMb: 12288,
      maxYoungGenerationSizeMb: 256,
    },
  });
  const requestId = `${Date.now()}-${Math.random().toString(16).slice(2)}`;

  return await new Promise<SerializedFolderTree>((resolve, reject) => {
    let settled = false;

    const settle = (callback: () => void) => {
      if (settled) return;
      settled = true;
      cleanup();
      callback();
    };

    const handleAbort = () => {
      void worker.terminate().finally(() => {
        settle(() => reject(new Error("Folder tree worker aborted")));
      });
    };

    const cleanup = () => {
      worker.off("message", onMessage);
      worker.off("error", onError);
      worker.off("exit", onExit);
      options.signal?.removeEventListener("abort", handleAbort);
    };

    const onMessage = (message: FolderTreeWorkerResponse) => {
      if (!message || message.requestId !== requestId) {
        return;
      }

      void worker.terminate().finally(() => {
        if (message.type === "result") {
          settle(() => resolve(message.tree));
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
        const detail = code === 1
          ? `Folder tree worker out of memory (exit code 1). The index may exceed the worker's 8 GB heap.`
          : `Folder tree worker exited with code ${code}`;
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

    const request: FolderTreeWorkerRequest = {
      type: "build",
      requestId,
      input,
    };
    worker.postMessage(request);
  });
}
