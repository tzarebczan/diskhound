import * as FS from "node:fs";
import * as FSP from "node:fs/promises";
import * as Path from "node:path";
import { createGzip, createGunzip } from "node:zlib";
import { createReadStream, createWriteStream, type WriteStream } from "node:fs";
import { createInterface } from "node:readline";

import type { FullDiffResult, FullFileChange } from "./contracts";
import { normPath } from "./pathUtils";

const INDEX_DIR = "scan-indexes";
const INDEX_SUFFIX = ".ndjson.gz";

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

/** Short NDJSON record: `{"p":"<path>","s":<size>,"m":<mtime>}` */
export interface IndexRecord {
  p: string;
  s: number;
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
      if (rec && typeof rec.p === "string") {
        map.set(normPath(rec.p), rec);
      }
    } catch { /* skip malformed lines */ }
  }
  return map;
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

/** Delete an index file if it exists (best effort). */
export async function deleteIndex(id: string): Promise<void> {
  try {
    await FSP.unlink(indexFilePath(id));
  } catch { /* already gone */ }
}
