import { spawn } from "node:child_process";
import { createReadStream, createWriteStream, existsSync } from "node:fs";
import * as FSP from "node:fs/promises";
import * as Path from "node:path";
import { createInterface } from "node:readline";
import { createGunzip, createGzip } from "node:zlib";

import type { ScanSnapshot } from "./shared/contracts";
import { buildSnapshotFromIndex, indexFilePath } from "./shared/scanIndex";
import {
  getCursor,
  setCursor,
  volumeForPath,
  type VolumeCursor,
} from "./shared/usnCursorStore";
import { normPath } from "./shared/pathUtils";

/**
 * End-to-end USN-journal based incremental monitoring.
 *
 * Primary contract:
 * - `queryCurrentCursor()` — ask the volume for its current USN+journalId so
 *   we can anchor the cursor right after a full scan completes.
 * - `runIncrementalScan()` — read the journal since the saved cursor, apply
 *   deltas to a copy of the previous index, build a fresh snapshot, return
 *   it. On any failure (journal wrapped, ID mismatch, spawn error) this
 *   returns null so the caller falls back to a full scan.
 *
 * This module is Windows-only in practice (the Rust binary's USN support is
 * gated on `cfg(windows)`). On other platforms the caller should simply not
 * wire up cursor capture, and `runIncrementalScan` will return null anyway
 * since there's no cursor.
 */

// ── JSON message shapes emitted by the Rust USN reader ─────────────────────

interface JournalRecord {
  type: "journal-record";
  op: "create" | "modify" | "delete" | "rename" | "close" | "other";
  path: string;
  fileRef: number;
  parentRef: number;
  usn: number;
  reasonMask: number;
  timestamp: number;
}

interface JournalCursorEnd {
  type: "journal-cursor";
  cursor: number;
  journalId: number;
  recordsEmitted: number;
  recordsDropped: number;
}

interface JournalErrorLine {
  type: "journal-error";
  message: string;
}

interface CursorQueryLine {
  type: "cursor-query";
  journalId: number;
  nextUsn: number;
  firstUsn: number;
  volume: string;
}

type AnyLine =
  | JournalRecord
  | JournalCursorEnd
  | JournalErrorLine
  | CursorQueryLine;

export interface IncrementalResult {
  snapshot: ScanSnapshot;
  newIndexPath: string;
  newCursor: VolumeCursor;
  stats: {
    recordsRead: number;
    recordsDropped: number;
    additions: number;
    modifications: number;
    deletions: number;
    elapsedMs: number;
  };
}

// ── Public API ─────────────────────────────────────────────────────────────

/**
 * Query the volume's current USN cursor + journal ID. Called right after a
 * full scan completes so the next monitoring tick knows where to start
 * reading from. Returns null if the query fails (e.g. non-NTFS, no
 * permission, journal disabled).
 */
export async function queryCurrentCursor(
  scannerPath: string,
  volume: string,
): Promise<{ cursor: number; journalId: number } | null> {
  const driveLetter = volume.replace(/[:\\/]+$/, "").charAt(0).toUpperCase();
  if (!driveLetter) return null;

  try {
    const result = await spawnJson(scannerPath, [
      "--mode", "query-cursor",
      "--volume", driveLetter,
    ], 5_000);

    for (const line of result.lines) {
      if (line.type === "cursor-query") {
        return { cursor: line.nextUsn, journalId: line.journalId };
      }
    }
  } catch {
    return null;
  }
  return null;
}

/**
 * Run an incremental scan using the USN journal. Returns null on any
 * condition that requires a full rescan (cursor predates journal, journal
 * ID mismatch, spawn failure, etc).
 */
export async function runIncrementalScan(params: {
  rootPath: string;
  scannerPath: string;
  previousIndexPath: string;
  newIndexPath: string;
  cursor: VolumeCursor;
}): Promise<IncrementalResult | null> {
  const startedAt = Date.now();
  const driveLetter = params.cursor.volume
    .replace(/[:\\/]+$/, "")
    .charAt(0)
    .toUpperCase();
  if (!driveLetter) return null;
  if (!existsSync(params.previousIndexPath)) return null;

  const spawnResult = await spawnJournal(params.scannerPath, driveLetter, params.cursor.cursor);
  if (!spawnResult) return null;
  const { records, cursorEnd } = spawnResult;

  // Journal ID mismatch: the volume's journal has been recreated (volume
  // reformatted, disabled+re-enabled, etc). Any cursor we have is stale.
  if (cursorEnd.journalId !== params.cursor.journalId) return null;

  // Filter records to those under the scan root.
  const rootNorm = normPath(params.rootPath);
  const rootPrefix = rootNorm.endsWith(Path.sep) ? rootNorm : rootNorm + Path.sep;
  const relevant = records.filter((r) => {
    const p = normPath(r.path);
    return p === rootNorm || p.startsWith(rootPrefix);
  });

  // Dedupe per path, keeping the most recent operation. We also prune "close"
  // events which don't represent content changes on their own.
  const byPath = new Map<string, JournalRecord>();
  for (const r of relevant) {
    if (r.op === "close" || r.op === "other") continue;
    byPath.set(normPath(r.path), r);
  }

  const deletes = new Set<string>();
  const createOrModify = new Set<string>();
  for (const [path, rec] of byPath) {
    if (rec.op === "delete") {
      deletes.add(path);
    } else {
      createOrModify.add(path);
    }
  }

  // Stat each create/modify target to get its current size + mtime. In
  // parallel — up to 32 concurrent stats — to stay well under fd limits.
  const freshEntries = await statInBatches(Array.from(createOrModify), 32);

  // Stream the previous index → new index, applying the deltas.
  const additions = await applyDeltasToIndex(
    params.previousIndexPath,
    params.newIndexPath,
    {
      deletes,
      updates: freshEntries,
    },
  );

  // Build the snapshot from the new index. This is a full re-read of the
  // new index, but since the index is gzipped NDJSON it's fast — single-
  // digit seconds for millions of entries.
  const snapshot = await buildSnapshotFromIndex({
    indexPath: params.newIndexPath,
    rootPath: params.rootPath,
    engine: "usn-journal",
    startedAt,
    elapsedMs: Date.now() - startedAt,
  });

  return {
    snapshot,
    newIndexPath: params.newIndexPath,
    newCursor: {
      volume: params.cursor.volume,
      cursor: cursorEnd.cursor,
      journalId: cursorEnd.journalId,
      capturedAt: Date.now(),
      rootPath: params.rootPath,
    },
    stats: {
      recordsRead: records.length,
      recordsDropped: cursorEnd.recordsDropped,
      additions: additions.additions,
      modifications: additions.modifications,
      deletions: additions.deletions,
      elapsedMs: Date.now() - startedAt,
    },
  };
}

/**
 * Convenience: returns the cursor currently persisted for the root's
 * volume. Thin wrapper that delegates to `usnCursorStore.getCursor`.
 */
export function getCursorForRoot(rootPath: string): VolumeCursor | null {
  return getCursor(volumeForPath(rootPath));
}

/** Convenience for the main-process post-scan capture path. */
export async function captureCursorAfterScan(
  scannerPath: string,
  rootPath: string,
): Promise<void> {
  const volume = volumeForPath(rootPath);
  if (!volume) return;

  const current = await queryCurrentCursor(scannerPath, volume);
  if (!current) return;

  await setCursor({
    volume,
    cursor: current.cursor,
    journalId: current.journalId,
    capturedAt: Date.now(),
    rootPath,
  });
}

// ── Internals ──────────────────────────────────────────────────────────────

/**
 * Spawn the Rust binary in journal mode, collect NDJSON output until it
 * exits, return structured arrays. Returns null on spawn/parse errors.
 */
async function spawnJournal(
  scannerPath: string,
  driveLetter: string,
  cursor: number,
): Promise<{ records: JournalRecord[]; cursorEnd: JournalCursorEnd } | null> {
  const result = await spawnJson(scannerPath, [
    "--mode", "journal",
    "--volume", driveLetter,
    "--cursor", String(cursor),
  ], 60_000);

  const records: JournalRecord[] = [];
  let cursorEnd: JournalCursorEnd | null = null;
  let errored = false;

  for (const line of result.lines) {
    if (line.type === "journal-record") records.push(line);
    else if (line.type === "journal-cursor") cursorEnd = line;
    else if (line.type === "journal-error") errored = true;
  }

  if (errored || !cursorEnd) return null;
  return { records, cursorEnd };
}

async function spawnJson(
  binaryPath: string,
  args: string[],
  timeoutMs: number,
): Promise<{ lines: AnyLine[]; exitCode: number | null }> {
  return await new Promise((resolve, reject) => {
    const child = spawn(binaryPath, args, {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });

    const lines: AnyLine[] = [];
    let stderrBuf = "";
    const rl = createInterface({ input: child.stdout, crlfDelay: Infinity });

    rl.on("line", (line) => {
      if (!line.trim()) return;
      try {
        const parsed = JSON.parse(line) as AnyLine;
        lines.push(parsed);
      } catch { /* skip */ }
    });

    child.stderr?.on("data", (chunk) => {
      stderrBuf += chunk.toString("utf8");
      if (stderrBuf.length > 16_384) stderrBuf = stderrBuf.slice(-16_384);
    });

    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`Timed out after ${timeoutMs}ms`));
    }, timeoutMs).unref();

    child.once("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      rl.close();
      resolve({ lines, exitCode: code });
    });
  });
}

/** Stat files in batches, return path → {size, mtime} for files that still exist. */
async function statInBatches(
  paths: string[],
  concurrency: number,
): Promise<Map<string, { size: number; mtime: number }>> {
  const result = new Map<string, { size: number; mtime: number }>();
  for (let i = 0; i < paths.length; i += concurrency) {
    const batch = paths.slice(i, i + concurrency);
    await Promise.all(
      batch.map(async (p) => {
        try {
          const st = await FSP.stat(p);
          if (st.isFile()) {
            result.set(normPath(p), { size: st.size, mtime: st.mtimeMs });
          }
        } catch {
          // File vanished between journal and stat, or no permission. The
          // next full scan will reconcile.
        }
      }),
    );
  }
  return result;
}

/**
 * Stream the previous gzipped NDJSON index, applying deletes + updates,
 * writing to a new gzipped NDJSON. Returns counts of each kind of mutation.
 */
async function applyDeltasToIndex(
  previousPath: string,
  newPath: string,
  deltas: {
    deletes: Set<string>;
    updates: Map<string, { size: number; mtime: number }>;
  },
): Promise<{ additions: number; modifications: number; deletions: number }> {
  // Work with a copy of `updates` so we can remove entries as we see them —
  // anything left over at the end is a pure addition.
  const pendingAdds = new Map(deltas.updates);
  let modifications = 0;
  let deletions = 0;

  await FSP.mkdir(Path.dirname(newPath), { recursive: true });

  const gzOut = createGzip({ level: 6 });
  const writeStream = createWriteStream(newPath);
  gzOut.pipe(writeStream);

  const writeLine = (obj: unknown) => {
    gzOut.write(JSON.stringify(obj) + "\n");
  };

  const gunzip = createGunzip();
  const source = createReadStream(previousPath);
  source.pipe(gunzip);

  const rl = createInterface({ input: gunzip, crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line) continue;
    let rec: { p?: string; s?: number; m?: number; t?: string };
    try { rec = JSON.parse(line); } catch { continue; }
    if (!rec || typeof rec.p !== "string") continue;

    const norm = normPath(rec.p);

    // Directory entries pass through unchanged. A full incremental would
    // update dir mtimes too, but for now we accept minor staleness — the
    // next full scan (or Phase-1 walk) refreshes them.
    if (rec.t === "d") {
      writeLine({ p: rec.p, t: "d", m: rec.m ?? 0 });
      continue;
    }

    if (deltas.deletes.has(norm)) {
      deletions += 1;
      continue;
    }

    const update = pendingAdds.get(norm);
    if (update) {
      writeLine({ p: rec.p, s: update.size, m: update.mtime });
      pendingAdds.delete(norm);
      modifications += 1;
      continue;
    }

    // Unchanged: pass through
    writeLine({ p: rec.p, s: rec.s ?? 0, m: rec.m ?? 0 });
  }

  // Anything still in pendingAdds is a new file not previously in the index.
  let additions = 0;
  for (const [path, fresh] of pendingAdds) {
    writeLine({ p: path, s: fresh.size, m: fresh.mtime });
    additions += 1;
  }

  await new Promise<void>((resolve) => {
    gzOut.end(() => resolve());
  });

  return { additions, modifications, deletions };
}

/** Re-export for main.ts to construct index paths by ID. */
export { indexFilePath };
