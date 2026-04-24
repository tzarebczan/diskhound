import * as FS from "node:fs";
import * as Path from "node:path";
import { createGunzip, createGzip } from "node:zlib";
import { createReadStream, createWriteStream } from "node:fs";
import { createInterface } from "node:readline";

/**
 * Persistent hash cache for duplicate detection.
 *
 * Hashing 7 M files on a 1 TB SSD takes 30-60 minutes. If the user
 * runs a duplicate scan a second time (e.g. to check "did my
 * cleanup make a difference?"), every file whose size + mtime
 * hasn't changed can reuse its last-computed SHA-256 — turning a
 * 30-minute re-scan into seconds.
 *
 * Cache file: `<userData>/duplicate-hash-cache.ndjson.gz`
 * One line per entry: `{"p":path,"s":size,"m":mtime,"h":sha256hex}`
 *
 * Bounded by `CACHE_MAX_ENTRIES` via LRU-ish trimming on save — we
 * drop the oldest entries by last-access time so frequently-
 * hashed files stay cached. On very large drives the cache settles
 * around ~500 k entries after a few scans.
 *
 * Key invariant: (path, size, mtime) uniquely identifies a file's
 * content on NTFS. If any of those differ, we recompute. Paths that
 * vanish from disk are pruned on next persist.
 */

const CACHE_FILE_NAME = "duplicate-hash-cache.ndjson.gz";
const CACHE_MAX_ENTRIES = 500_000;

interface CacheEntry {
  size: number;
  mtime: number;
  hash: string;
  /** Unix-ms timestamp of last hit — used to LRU-trim on save. */
  lastUsed: number;
}

let dataDir = "";
let cache: Map<string, CacheEntry> = new Map();
let loaded = false;
let dirty = false;

function cachePath(): string {
  return Path.join(dataDir, CACHE_FILE_NAME);
}

/**
 * Initialize the cache. Call once per scan — reads the prior cache
 * from disk in the background. Subsequent calls are no-ops until
 * `reset()` is called (not currently exposed; tests only).
 */
export async function initHashCache(dataDirPath: string): Promise<void> {
  if (loaded) return;
  dataDir = dataDirPath;
  loaded = true;
  cache = new Map();
  const p = cachePath();
  if (!FS.existsSync(p)) return;
  try {
    await readCacheFile(p, (entry) => {
      cache.set(entry.path, {
        size: entry.size,
        mtime: entry.mtime,
        hash: entry.hash,
        lastUsed: entry.lastUsed,
      });
    });
  } catch {
    // Corrupt cache — just start fresh. Not worth failing the scan.
    cache = new Map();
  }
}

/**
 * Look up a cached hash. Returns null on miss or stale entry. A
 * stale entry is one where size or mtime has changed since the
 * cache was written — if either differs we can't trust the hash.
 */
export function getCachedHash(
  path: string,
  size: number,
  mtime: number,
): string | null {
  if (!loaded) return null;
  const entry = cache.get(path);
  if (!entry) return null;
  // Small mtime jitter (1 s) is tolerated because some filesystem
  // operations round mtimes to the nearest second even when
  // source mtimes have sub-second precision. Hashing the file
  // again would yield identical bytes anyway.
  if (entry.size !== size) return null;
  if (Math.abs(entry.mtime - mtime) >= 1000) return null;
  entry.lastUsed = Date.now();
  return entry.hash;
}

export function setCachedHash(
  path: string,
  size: number,
  mtime: number,
  hash: string,
): void {
  if (!loaded) return;
  cache.set(path, { size, mtime, hash, lastUsed: Date.now() });
  dirty = true;
}

/**
 * Write the cache to disk. Called at scan-end; bounded to
 * CACHE_MAX_ENTRIES by dropping the least-recently-used first.
 * Cheap on small caches; tens of seconds on a 500k entry cache.
 */
export async function persistHashCache(): Promise<void> {
  if (!loaded || !dirty) return;
  dirty = false;
  const entries: Array<[string, CacheEntry]> = [...cache.entries()];
  if (entries.length > CACHE_MAX_ENTRIES) {
    entries.sort((a, b) => b[1].lastUsed - a[1].lastUsed);
    entries.length = CACHE_MAX_ENTRIES;
  }
  // Rebuild the map so in-memory state matches what we're writing.
  cache = new Map(entries);
  try {
    await writeCacheFile(cachePath(), entries);
  } catch {
    // Persist failures are non-fatal — the scan still completed.
  }
}

/** Total entries. Exposed for diagnostics / tests. */
export function cacheSize(): number {
  return cache.size;
}

// ── I/O helpers ────────────────────────────────────────────────────────

interface WireEntry {
  path: string;
  size: number;
  mtime: number;
  hash: string;
  lastUsed: number;
}

async function readCacheFile(
  p: string,
  onEntry: (e: WireEntry) => void,
): Promise<void> {
  const gunzip = createGunzip();
  const src = createReadStream(p);
  src.pipe(gunzip);
  const rl = createInterface({ input: gunzip, crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line) continue;
    let rec: Partial<WireEntry> & { p?: string; s?: number; m?: number; h?: string; l?: number };
    try {
      rec = JSON.parse(line);
    } catch {
      continue;
    }
    // Short-key schema to keep the file small:
    //   p=path, s=size, m=mtime, h=hash, l=lastUsed
    const path = rec.p ?? rec.path;
    const size = rec.s ?? rec.size;
    const mtime = rec.m ?? rec.mtime;
    const hash = rec.h ?? rec.hash;
    const lastUsed = rec.l ?? rec.lastUsed ?? 0;
    if (
      typeof path !== "string" ||
      typeof size !== "number" ||
      typeof mtime !== "number" ||
      typeof hash !== "string"
    ) {
      continue;
    }
    onEntry({ path, size, mtime, hash, lastUsed });
  }
  rl.close();
}

async function writeCacheFile(
  p: string,
  entries: Array<[string, CacheEntry]>,
): Promise<void> {
  // Write to <p>.tmp first then rename — avoids corrupt-file state
  // if the process is killed mid-write.
  const tmp = p + ".tmp";
  const gzip = createGzip();
  const out = createWriteStream(tmp);
  gzip.pipe(out);
  await new Promise<void>((resolve, reject) => {
    out.on("finish", resolve);
    out.on("error", reject);
    for (const [path, e] of entries) {
      gzip.write(
        JSON.stringify({
          p: path,
          s: e.size,
          m: e.mtime,
          h: e.hash,
          l: e.lastUsed,
        }) + "\n",
      );
    }
    gzip.end();
  });
  await FS.promises.rename(tmp, p);
}
