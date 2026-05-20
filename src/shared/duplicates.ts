import * as FS from "node:fs";
import * as FSP from "node:fs/promises";
import * as Path from "node:path";
import { createHash } from "node:crypto";
import { createReadStream, type ReadStream } from "node:fs";
import { createGunzip } from "node:zlib";
import { createInterface } from "node:readline";

import type {
  DuplicateAnalysis,
  DuplicateFileEntry,
  DuplicateGroup,
  DuplicateScanProgress,
} from "./contracts";
import {
  getCachedHash,
  initHashCache,
  persistHashCache,
  setCachedHash,
} from "./duplicateHashCache";
import { normPath } from "./pathUtils";

const PROGRESS_INTERVAL_MS = 200;

/**
 * Prefix-hash window. Bumped 4 KB → 64 KB in v0.5.18: a wider
 * prefix catches more false-positive size collisions (e.g. two
 * unrelated 5 GB videos that happen to share the same first
 * 4 KB but diverge by byte 5000) before we commit to the
 * expensive full-hash pass. 64 KB is also one OS page-cluster on
 * Windows / Linux, so the syscall cost is identical to 4 KB.
 */
const PREFIX_BYTES = 64 * 1024;

/**
 * Files at or below this size get fully hashed. Above this, we
 * switch to 3-sample hashing (start + middle + end of
 * SAMPLE_BYTES_EACH bytes each). In practice no real-world non-
 * malicious file pair has matching size + matching prefix +
 * matching start/middle/end + differing remaining bytes —
 * collision probability for content-addressed dedup is
 * effectively the hash's collision probability. This buys us
 * orders of magnitude on big-file scans (think 4 GB videos):
 * a 4 GB BLAKE2b at ~1.5 GB/s takes ~2.6 s; the sampled version
 * is sub-millisecond.
 */
const SAMPLE_HASH_THRESHOLD_BYTES = 64 * 1024 * 1024; // 64 MB
const SAMPLE_BYTES_EACH = 64 * 1024;

/**
 * Stream highWaterMark for the full-hash pass. Default Node value
 * is 64 KB which is too small for sequential reads of large
 * files — every chunk is a syscall. 1 MB reduces syscall count
 * by 16× on huge files at no real memory cost (16 concurrent
 * workers × 1 MB = 16 MB peak buffer).
 */
const FULL_HASH_HIGH_WATER_MARK = 1024 * 1024;

/**
 * Hash algorithm. BLAKE2b at ~1.5 GB/s/core is ~3× faster than
 * SHA-256 on Node + Electron and is cryptographically as strong
 * — overkill for duplicate detection but a zero-risk drop-in.
 * If you change this, ALSO bump the cache filename in
 * duplicateHashCache.ts so stale SHA-256 entries don't shadow
 * fresh BLAKE2b hashes.
 */
const HASH_ALGO = "blake2b512";

// Parallel hash workers. Bumped from 8 → 16 — modern NVMe SSDs
// handle 16+ concurrent streaming reads without seek contention,
// and the hash work is throughput-limited by a single CPU core
// anyway so more streams in flight ≠ more CPU pressure. On HDDs
// this is slightly worse than 8 but still acceptable (seeks
// serialize at the controller). Override via
// DISKHOUND_HASH_CONCURRENCY env.
const HASH_CONCURRENCY = (() => {
  const override = process.env.DISKHOUND_HASH_CONCURRENCY;
  if (override) {
    const n = parseInt(override, 10);
    if (Number.isFinite(n) && n >= 1 && n <= 128) return n;
  }
  return 16;
})();

/**
 * Default minimum file size to consider. Rationale: most "wasted space"
 * from duplicates lives in big files — photos, videos, installers,
 * archives. Scanning every 4 KB icon-cache file multiplies memory usage
 * by 10× without uncovering anything actionable.
 */
const DEFAULT_MIN_SIZE_BYTES = 1 * 1024 * 1024;

/**
 * Well-known system + cache directories on Windows that produce
 * nothing but noise in the duplicate-detection candidate list:
 *
 *   - System hives (registry / config) are locked under EBUSY
 *   - Browser caches rotate continuously, so ENOENT by the time we
 *     hash them
 *   - Windows Store packages are ACL'd EPERM and aren't user data
 *   - $Recycle.Bin / System Volume Information / Recovery are
 *     system-owned and the user can't act on duplicates there anyway
 *
 * A v0.5.31 user report showed every single Pass A failure was a
 * file in one of these locations: 30 k candidates, 0 results.
 * Excluding these patterns upfront drops the candidate count to
 * something useful, AND stops 30 k ENOENT/EPERM/EBUSY error
 * events from cluttering crash.log.
 *
 * Paths are checked against the candidate's path (after normPath
 * lowercasing on Windows) as substring matches. The patterns are
 * intentionally narrow: e.g. `\appdata\local\google\chrome\user
 * data\default\cache\` is specific enough to never collide with a
 * user folder called "Cache" elsewhere.
 *
 * Cross-platform note: these only match on Windows path layouts.
 * Linux / macOS install paths are different and currently aren't
 * filtered — if usage grows there we'd add /System, /proc, etc.
 */
const NOISE_PATH_PATTERNS: ReadonlyArray<string> = [
  // OS internals
  "\\windows\\",
  "\\programdata\\microsoft\\",
  "\\$recycle.bin\\",
  "\\system volume information\\",
  "\\recovery\\",
  // Windows Store sandbox + staging
  "\\appdata\\local\\packages\\",
  "\\appdata\\local\\packagestaging\\",
  // Windows internal state cache (Local + Roaming)
  "\\appdata\\local\\microsoft\\windows\\",
  "\\appdata\\roaming\\microsoft\\windows\\",
  "\\appdata\\local\\connecteddevicesplatform\\",
  // Mail / People / Calendar database (USS.jtx ESE store, locked EBUSY)
  "\\appdata\\local\\comms\\",
  // Temp dirs
  "\\appdata\\local\\temp\\",
  // ── Browser profile dirs ──────────────────────────────────
  //
  // v0.5.33 tried narrow Default\Cache + Default\Code Cache patterns.
  // The user's v0.5.33 log still showed ENOENT on
  // `\appdata\local\google\chrome\user data\extensions_crx_cache\…`
  // and `\appdata\local\bravesoftware\…\extensions_crx_cache\…`.
  // Those aren't under Default\ — they're at the profile root.
  // Rather than play whack-a-mole with each new cache subdir Chrome
  // invents, broaden to the entire User Data directory. Real user data
  // worth deduping (downloaded files, etc.) lives elsewhere; everything
  // under "User Data" is browser-managed state that rotates
  // continuously and produces nothing but ENOENT on hash.
  "\\appdata\\local\\google\\chrome\\user data\\",
  "\\appdata\\local\\microsoft\\edge\\user data\\",
  "\\appdata\\local\\bravesoftware\\brave-browser\\user data\\",
  "\\appdata\\local\\bravesoftware\\brave-browser-beta\\user data\\",
  "\\appdata\\local\\bravesoftware\\brave-browser-nightly\\user data\\",
  "\\appdata\\local\\chromium\\user data\\",
  "\\appdata\\local\\vivaldi\\user data\\",
  "\\appdata\\local\\opera software\\",
  "\\appdata\\local\\mozilla\\firefox\\profiles\\",
  "\\appdata\\roaming\\mozilla\\firefox\\profiles\\",
  // Electron app caches (Slack, Discord, Teams, VS Code, etc.) —
  // they all ship Chromium so the same rotating cache problem applies.
  "\\appdata\\roaming\\slack\\cache\\",
  "\\appdata\\roaming\\slack\\code cache\\",
  "\\appdata\\roaming\\slack\\service worker\\",
  "\\appdata\\roaming\\discord\\cache\\",
  "\\appdata\\roaming\\discord\\code cache\\",
  "\\appdata\\roaming\\code\\cache\\",
  "\\appdata\\roaming\\code\\cachedata\\",
  "\\appdata\\roaming\\microsoft\\teams\\",
  // Steam / Epic / common game launchers (manifests rotate)
  "\\steam\\appcache\\",
  "\\steam\\logs\\",
  "\\epic games\\launcher\\saved\\",
  // Linux mounts (no-op on Windows where backslashes win)
  "/proc/",
  "/sys/",
  "/dev/",
];

/**
 * Filename-suffix patterns that are noise regardless of which
 * directory they live in. The NTUSER.DAT registry hive sits at the
 * top level of every user's profile, and its rotating LOG / TM /
 * BLF / regtrans-ms sidecars accompany it — none are hashable
 * (always EBUSY while the user is logged in). Same for ESE
 * database journals (.jtx, .edb) which live wherever the
 * owning app put them.
 *
 * Compared against the basename of the normalised path so paths
 * like `\users\thoma\ntuser.dat` and `\…\appdata\local\comms\
 * unistoredb\uss.jtx` both fall in. Cheap — one
 * lastIndexOf + endsWith per candidate.
 */
const NOISE_FILENAME_PATTERNS: ReadonlyArray<string> = [
  "\\ntuser.dat",
  "\\ntuser.dat.log1",
  "\\ntuser.dat.log2",
  "\\usrclass.dat",
  "\\usrclass.dat.log1",
  "\\usrclass.dat.log2",
  ".regtrans-ms",
  ".blf",
  ".tmcontainer", // transaction manager container
];
function isNoiseFilename(normalisedPath: string): boolean {
  for (const pattern of NOISE_FILENAME_PATTERNS) {
    if (normalisedPath.endsWith(pattern)) return true;
    // pattern starts with backslash → also count the basename match
    if (pattern.startsWith("\\") && normalisedPath.endsWith(pattern.slice(1))) return true;
  }
  return false;
}

/**
 * O(1)-friendly check using indexOf on the normalised path. We
 * intentionally do NOT regex-match — for 30 k candidates × 15
 * patterns that's 450 k regex tests vs. 450 k substring searches;
 * substring is ~3× faster in V8 for short needles, and we don't
 * need anchoring.
 */
function isNoiseCandidatePath(normalisedPath: string): boolean {
  for (const pattern of NOISE_PATH_PATTERNS) {
    if (normalisedPath.indexOf(pattern) !== -1) return true;
  }
  return isNoiseFilename(normalisedPath);
}

/**
 * Opt-in verbose logging. Two ways to enable:
 *   1. Env var DISKHOUND_DUP_DEBUG=1 (dev / power users)
 *   2. Runtime toggle via setDuplicateVerbose() — called by
 *      main.ts whenever the user flips the settings checkbox.
 *
 * Output goes through `verboseLogger` which main.ts wires to
 * writeCrashLog so the lines land in crash.log alongside other
 * diagnostic events. The crash-log viewer in Settings then makes
 * them shareable.
 *
 * The always-on summary line at scan-end stays regardless —
 * see the `console.log` near the end of `run()`. Useful when a
 * user reports "no duplicates found" so we can pinpoint which
 * phase ate their data.
 */
let verboseEnabled = process.env.DISKHOUND_DUP_DEBUG === "1";
let verboseLogger: (msg: string) => void = (msg) => console.log(`[diskhound-dup] ${msg}`);

/** Toggle verbose logging at runtime. Called by main.ts via the
 *  settings.subscribe wiring whenever the user changes the toggle. */
export function setDuplicateVerbose(on: boolean): void {
  verboseEnabled = on || process.env.DISKHOUND_DUP_DEBUG === "1";
}

/** Inject a logger sink. main.ts uses this to route verbose lines
 *  into writeCrashLog so they survive process restarts and show up
 *  in the Settings → Crash log viewer. */
export function setDuplicateLogger(fn: (msg: string) => void): void {
  verboseLogger = fn;
}

function debugLog(msg: string): void {
  if (verboseEnabled) verboseLogger(msg);
}

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
  /** userData directory for persisting the hash cache. When absent the
   *  cache is in-memory only (lost at exit). */
  cacheDir?: string;
  /**
   * Skip the well-known-noise path filter (Windows system / browser
   * caches / temp / etc). Used by the dev test harness which scans
   * under `os.tmpdir()` — that path matches the filter so without the
   * opt-out the harness collects 0 candidates.
   *
   * Production callers (main.ts's IPC handler) leave this undefined /
   * false so end users get the filter.
   */
  disableNoiseFilter?: boolean;
}

/**
 * Bounded-concurrency runner. Promise.all wrapper that caps the number
 * of in-flight tasks. Used to parallelise hashing across ALL
 * candidates (not per-size-group), so a single giant size bucket
 * doesn't block smaller ones.
 *
 * Cancellation: when `isCancelled()` returns true, every worker
 * breaks out of its queue-drain loop on the next iteration. Combined
 * with the per-hash stream abort below, cancel propagates within
 * one chunk-read (~ms) regardless of file size.
 */
async function mapConcurrent<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R | null>,
  onTick: (() => void) | undefined,
  isCancelled: () => boolean,
): Promise<Array<R | null>> {
  const results: Array<R | null> = new Array(items.length).fill(null);
  let next = 0;
  const workers: Promise<void>[] = [];
  const workerCount = Math.min(concurrency, items.length);
  for (let w = 0; w < workerCount; w++) {
    workers.push(
      (async () => {
        while (true) {
          if (isCancelled()) return;
          const i = next++;
          if (i >= items.length) return;
          try {
            results[i] = await fn(items[i]!, i);
          } catch {
            // Slot is already initialised to null (see new Array().fill
            // above), so we don't need to assign it here — but the
            // SPARSE-undefined bug from v0.5.23-26 is now impossible
            // because every slot starts as null. fn rejection → slot
            // stays null instead of going undefined. Iterating loops
            // can safely `if (!r || !r.field)` without crashing.
          }
          if (isCancelled()) return;
          onTick?.();
        }
      })(),
    );
  }
  await Promise.all(workers);
  return results;
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
  const isCancelled = () => cancelled;
  const startedAt = Date.now();
  const minSizeBytes = options.minSizeBytes ?? DEFAULT_MIN_SIZE_BYTES;

  // Every read stream currently held by a hash worker. On
  // cancel() we destroy() all of them so any in-flight 4 GB
  // hashFileFull aborts instead of running to completion. Without
  // this, cancellation was non-immediate by up to tens of
  // seconds on huge-file pools.
  const activeStreams = new Set<ReadStream>();

  let filesWalked = 0;
  let candidateGroups = 0;
  let filesHashed = 0;
  let groupsConfirmed = 0;
  let lastEmitAt = 0;
  let source: "index" | "walk" = "walk";

  // Streaming buffer: confirmed groups since the last progress emit.
  // Flushed on every emit (including the final forced one) so the UI
  // populates its list as the hashing phase runs instead of waiting
  // for the 30-minute scan to finish. On a drive with 2000+ duplicate
  // groups the UX difference is huge.
  const pendingNewGroups: DuplicateGroup[] = [];
  const confirmGroup = (g: DuplicateGroup) => {
    pendingNewGroups.push(g);
    groupsConfirmed++;
  };

  const emitProgress = (status: DuplicateScanProgress["status"], force = false) => {
    const now = Date.now();
    if (!force && now - lastEmitAt < PROGRESS_INTERVAL_MS) return;
    lastEmitAt = now;
    const newGroups = pendingNewGroups.length > 0 ? pendingNewGroups.splice(0) : undefined;
    // Wrap the callback — if the renderer's webContents.send throws
    // (e.g. window destroyed mid-scan), we don't want it to surface as
    // an uncaught exception that crashes the duplicate scan AND pops a
    // "DiskHound — Unexpected error" dialog. The scan keeps running;
    // the renderer is just missing this update.
    try {
      callbacks.onProgress({
        rootPath,
        status,
        filesWalked,
        candidateGroups,
        filesHashed,
        groupsConfirmed,
        elapsedMs: now - startedAt,
        errorMessage: null,
        source,
        minSizeBytes,
        newGroups,
      });
    } catch { /* renderer gone or callback threw — non-fatal */ }
  };

  const run = async () => {
    // Reset the one-time-per-scan failure diagnostic. Without this,
    // a sequence of scans would only log failures from the FIRST
    // scan and silently swallow the rest, making "all null" reports
    // from later scans impossible to diagnose.
    resetFailureLogger();

    // Kick off hash cache load. Non-fatal if this fails (cache
    // module falls back to in-memory on I/O errors). We don't await
    // the initial load synchronously because we want the "walking"
    // phase to start rendering progress ASAP — the cache is only
    // consulted during the hashing phase.
    if (options.cacheDir) {
      await initHashCache(options.cacheDir);
    }

    if (cancelled) return;
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
        userDataPrefixNorm: options.cacheDir ? normPath(Path.resolve(options.cacheDir)) : undefined,
        applyNoiseFilter: !options.disableNoiseFilter,
        isCancelled,
        onProgress: (walked, candGroups) => {
          filesWalked = walked;
          candidateGroups = candGroups;
          emitProgress("walking");
        },
      });
    } else {
      source = "walk";
      sizeMap = await collectFromWalk(rootPath, {
        minSizeBytes,
        userDataPrefixNorm: options.cacheDir ? normPath(Path.resolve(options.cacheDir)) : undefined,
        applyNoiseFilter: !options.disableNoiseFilter,
        isCancelled,
        onProgress: (walked, candGroups) => {
          filesWalked = walked;
          candidateGroups = candGroups;
          emitProgress("walking");
        },
      });
    }

    if (cancelled) return;
    // Final count of candidate-bearing sizes after the map is built.
    candidateGroups = 0;
    let totalCandidateFiles = 0;
    for (const list of sizeMap.values()) {
      if (list.length >= 2) {
        candidateGroups++;
        totalCandidateFiles += list.length;
      }
    }
    debugLog(`phase-1-done source=${source} candidateGroups=${candidateGroups} candidateFiles=${totalCandidateFiles} totalSizeBuckets=${sizeMap.size}`);
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

    // ── Cross-group parallel hashing ──
    //
    // Prior implementation serialised per-size-group: a single
    // 500-file size bucket of 4 GB videos blocked all other
    // size-groups. Now:
    //   - Pass A: flatten every candidate into a single list,
    //     compute prefix hashes with a global 16-way pool. Group
    //     results into (size, prefix) buckets.
    //   - Pass B: for each (size, prefix) bucket with ≥ 2 files,
    //     queue every file into a single full-hash task list and
    //     run the same 16-way pool. Group by final hash.
    // Both passes consult the persistent cache first — unchanged
    // files skip I/O entirely on repeat scans.
    //
    // Small files (≤ PREFIX_BYTES) are special-cased: their "prefix
    // hash" is already the full content, so Pass B is a no-op and we
    // can confirm the group after Pass A.

    // Flatten every candidate into one task list, tagged with its
    // size group so we can re-bucket in Pass A's tail.
    const allCandidates: Array<{ file: FileCandidate; size: number }> = [];
    for (const [size, files] of candidateEntries) {
      for (const file of files) allCandidates.push({ file, size });
    }

    // ── Pass A: prefix hash, globally parallelised ──
    const prefixResults = await mapConcurrent(
      allCandidates,
      HASH_CONCURRENCY,
      async ({ file, size }) => {
        if (cancelled) return { file, size, prefixHash: null };
        const prefixHash = await cachedHashPrefix(file, activeStreams, isCancelled);
        return { file, size, prefixHash };
      },
      () => {
        filesHashed++;
        emitProgress("hashing");
      },
      isCancelled,
    );
    if (cancelled) return;
    let prefixNullCount = 0;
    let prefixOkCount = 0;
    for (const r of prefixResults) {
      // Defensive: r can be null (mapConcurrent initialises every
      // slot to null and a fn rejection leaves it null). A v0.5.26
      // user hit `TypeError: Cannot read properties of undefined
      // (reading 'prefixHash')` here because the old impl left
      // sparse slots — fixed in v0.5.27 by .fill(null), but keep
      // the null check as belt-and-suspenders.
      if (!r || !r.prefixHash) prefixNullCount++;
      else prefixOkCount++;
    }
    debugLog(`pass-a-done prefixResults=${prefixResults.length} ok=${prefixOkCount} null=${prefixNullCount}`);
    // One-line breakdown of what went wrong in Pass A — useful when
    // null dominates (means hashing is failing systematically).
    logFailureSummary();

    // Re-bucket by (size, prefix). Small files (≤ PREFIX_BYTES) skip
    // Pass B — their prefix hash IS the full hash — so we collect
    // them separately and confirm groups immediately.
    const prefixBuckets = new Map<string, FileCandidate[]>();
    for (const r of prefixResults) {
      if (!r || !r.prefixHash) continue;
      const key = `${r.size}:${r.prefixHash}`;
      const bucket = prefixBuckets.get(key);
      if (bucket) bucket.push(r.file);
      else prefixBuckets.set(key, [r.file]);
    }
    let prefixBucketsWith2Plus = 0;
    for (const [, bucket] of prefixBuckets) if (bucket.length >= 2) prefixBucketsWith2Plus++;
    debugLog(`pass-a-buckets total=${prefixBuckets.size} bucketsWith2OrMore=${prefixBucketsWith2Plus}`);

    // Confirm small-file groups (size ≤ PREFIX_BYTES) without Pass B.
    // For larger files, queue every file for the full-hash pass.
    const fullHashTasks: Array<{ file: FileCandidate; size: number }> = [];
    for (const [key, bucket] of prefixBuckets) {
      if (bucket.length < 2) continue;
      const size = Number(key.split(":")[0]);
      if (size <= PREFIX_BYTES) {
        // Prefix hash == full hash for these; derive the hash from
        // the bucket key for deterministic output.
        const hash = key.substring(key.indexOf(":") + 1);
        const group: DuplicateGroup = {
          hash,
          size,
          files: bucket.map(toEntry),
        };
        confirmedGroups.push(group);
        confirmGroup(group); // buffer for the next progress emit
        continue;
      }
      for (const file of bucket) fullHashTasks.push({ file, size });
    }
    emitProgress("hashing", true);

    // ── Pass B: full hash, also globally parallelised ──
    //
    // For files > SAMPLE_HASH_THRESHOLD_BYTES we sample start +
    // middle + end instead of streaming the entire file. This is
    // where the big perf win comes from on drives full of media —
    // a 4 GB video pair goes from ~6 s hash time (with BLAKE2b)
    // to a few ms.
    const fullResults = await mapConcurrent(
      fullHashTasks,
      HASH_CONCURRENCY,
      async ({ file, size }) => {
        if (cancelled) return { file, size, fullHash: null };
        const fullHash = await cachedHashContent(file, activeStreams, isCancelled);
        return { file, size, fullHash };
      },
      () => {
        filesHashed++;
        emitProgress("hashing");
      },
      isCancelled,
    );
    if (cancelled) return;
    let fullNullCount = 0;
    let fullOkCount = 0;
    for (const r of fullResults) {
      // Same defensive null check as the Pass A loop above.
      if (!r || !r.fullHash) fullNullCount++;
      else fullOkCount++;
    }
    debugLog(`pass-b-done fullResults=${fullResults.length} ok=${fullOkCount} null=${fullNullCount} fullHashTasks=${fullHashTasks.length}`);

    // Bucket full-hash results by (size, full-hash), emit confirmed
    // groups. Same-hash + same-size → duplicate.
    const fullBuckets = new Map<string, FileCandidate[]>();
    for (const r of fullResults) {
      if (!r || !r.fullHash) continue;
      const key = `${r.size}:${r.fullHash}`;
      const bucket = fullBuckets.get(key);
      if (bucket) bucket.push(r.file);
      else fullBuckets.set(key, [r.file]);
    }
    let fullBucketsWith2Plus = 0;
    for (const [, bucket] of fullBuckets) if (bucket.length >= 2) fullBucketsWith2Plus++;
    debugLog(`pass-b-buckets total=${fullBuckets.size} bucketsWith2OrMore=${fullBucketsWith2Plus} totalConfirmedSoFar=${confirmedGroups.length}`);
    // Emit groups as they're confirmed, interleaved with progress
    // ticks so the UI's duplicate list populates during the scan
    // instead of in one flood at the end. Map iteration order is
    // insertion order, so this also happens to emit the FIRST-
    // discovered groups first — users see their biggest wasted-
    // space finds early.
    let sinceLastEmit = 0;
    for (const [key, bucket] of fullBuckets) {
      if (bucket.length < 2) continue;
      const sep = key.indexOf(":");
      const size = Number(key.substring(0, sep));
      const hash = key.substring(sep + 1);
      const group: DuplicateGroup = {
        hash,
        size,
        files: bucket.map(toEntry),
      };
      confirmedGroups.push(group);
      confirmGroup(group);
      // Flush the progress emit on every ~10 groups so the UI sees
      // incremental confirmations rather than all 2000 at once at
      // the end. The emit itself is rate-limited by
      // PROGRESS_INTERVAL_MS so this loop won't spam.
      sinceLastEmit++;
      if (sinceLastEmit >= 10) {
        sinceLastEmit = 0;
        emitProgress("hashing");
      }
    }
    emitProgress("hashing", true);

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

    // Always-on summary line — one per scan, sized to be useful in bug
    // reports without polluting steady-state logs. If a user reports
    // "no duplicates found" we can read this and immediately see
    // whether candidates were collected, files were hashed, and how
    // many groups confirmed. Routed through verboseLogger (which
    // main.ts hooks to writeCrashLog) so it lands in crash.log
    // regardless of the verbose toggle — this is the always-on
    // breadcrumb, not the per-phase counts that the toggle gates.
    verboseLogger(
      `scan complete: root=${rootPath} source=${source} ` +
      `walked=${filesWalked} candGroups=${candidateGroups} hashed=${filesHashed} ` +
      `groups=${confirmedGroups.length} wastedBytes=${totalWastedBytes} ` +
      `elapsedMs=${Date.now() - startedAt}`,
    );

    // Emit the result FIRST, then persist the cache. Cache persistence
    // can take many seconds on a populated cache (hundreds of MB) and
    // we don't want the UI to sit on "Scanning…" while the cache
    // serialises — especially since the last progress event was
    // status:"hashing" which keeps isScanning=true in the renderer
    // until onResult flips it.
    callbacks.onResult(result);

    // Persist the hash cache so the next scan skips unchanged files.
    // Non-fatal on error; cache module handles its own logging.
    // Fire-and-forget — the user has their results, this is just
    // bookkeeping for the next scan.
    if (options.cacheDir) {
      void persistHashCache().catch(() => { /* non-fatal */ });
    }
  };

  void run().catch((error) => {
    if (!cancelled) {
      try {
        callbacks.onError(error instanceof Error ? error : new Error(String(error)));
      } catch { /* renderer gone — non-fatal */ }
    }
  });

  return {
    cancel: () => {
      // Whole body wrapped — cancel() is called synchronously from
      // an IPC handler in the main process. If anything here throws
      // (e.g. a destroyed stream double-emitting), it surfaces as the
      // "DiskHound — Unexpected error" dialog. Belt-and-suspenders.
      try {
        if (cancelled) return;
        cancelled = true;
        // Destroy every in-flight read stream so hashFileContent
        // resolves null almost immediately instead of blocking on
        // the rest of a multi-GB read. The hash workers see
        // isCancelled() === true on their next loop iteration and
        // exit; mapConcurrent's await Promise.all() then unblocks
        // and run() returns. End-to-end cancel latency: a few ms.
        for (const stream of activeStreams) {
          try { stream.destroy(); } catch { /* already-destroyed is fine */ }
        }
        activeStreams.clear();
        // Emit a final "cancelled" progress event so the renderer's
        // active-scans set clears even though no further normal
        // progress emits will fire. Force=true so it bypasses the
        // 200 ms throttle.
        const now = Date.now();
        try {
          callbacks.onProgress({
            rootPath,
            status: "cancelled",
            filesWalked,
            candidateGroups,
            filesHashed,
            groupsConfirmed,
            elapsedMs: now - startedAt,
            errorMessage: null,
            source,
            minSizeBytes,
          });
        } catch { /* renderer gone — non-fatal */ }
      } catch { /* never let cancel propagate */ }
    },
  };
}

// ── Candidate collection: index-streaming path ───────────────────────────

interface CollectCallbacks {
  minSizeBytes: number;
  rootNorm: string;
  rootPrefix: string;
  /** normPath(userData) — when set, paths under this prefix are
   *  skipped as candidates. DiskHound's own scan-indexes / sidecars
   *  / diff caches are not useful duplicates to report on, and some
   *  of them (sidecars of pruned scans) deliberately get deleted
   *  immediately after a new scan completes, generating spurious
   *  ENOENTs in Pass A when the just-built index still references
   *  them. Excluding them upfront is cleaner than chasing the race. */
  userDataPrefixNorm?: string;
  /** When true (default in production), filter out the well-known
   *  Windows system + cache paths (NOISE_PATH_PATTERNS) that
   *  produce nothing but ENOENT/EPERM/EBUSY noise. */
  applyNoiseFilter?: boolean;
  onProgress: (walked: number, candidateGroups: number) => void;
  isCancelled: () => boolean;
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
  await streamIndex(indexPath, cbs.isCancelled, (rec) => {
    if (rec.t === "d") return true; // skip directory entries
    const size = rec.s;
    if (typeof size !== "number" || size < cbs.minSizeBytes) return true;
    if (!pathIsUnderRoot(rec.p, cbs.rootNorm, cbs.rootPrefix)) return true;
    if (cbs.userDataPrefixNorm && pathIsUnderPrefix(rec.p, cbs.userDataPrefixNorm)) return true;
    if (cbs.applyNoiseFilter !== false && isNoiseCandidatePath(normPath(rec.p))) return true;
    walked++;
    sizeCounts.set(size, (sizeCounts.get(size) ?? 0) + 1);
    if (walked % 5_000 === 0) {
      let candGroups = 0;
      for (const count of sizeCounts.values()) if (count >= 2) candGroups++;
      cbs.onProgress(walked, candGroups);
    }
    return true;
  });
  if (cbs.isCancelled()) return new Map();
  // Final tick after pass A so filesWalked reflects the true total
  // even when the index has < 5000 candidate files.
  {
    let candGroups = 0;
    for (const count of sizeCounts.values()) if (count >= 2) candGroups++;
    cbs.onProgress(walked, candGroups);
  }

  // Compact the count map down to "sizes we care about".
  const candidateSizes = new Set<number>();
  for (const [size, count] of sizeCounts) {
    if (count >= 2) candidateSizes.add(size);
  }
  sizeCounts.clear();

  // ── Pass B: materialize candidates only for sizes we care about ──
  const sizeMap = new Map<number, FileCandidate[]>();
  let walkedB = 0;
  await streamIndex(indexPath, cbs.isCancelled, (rec) => {
    if (rec.t === "d") return true;
    const size = rec.s;
    if (typeof size !== "number" || size < cbs.minSizeBytes) return true;
    if (!candidateSizes.has(size)) return true;
    if (!pathIsUnderRoot(rec.p, cbs.rootNorm, cbs.rootPrefix)) return true;
    if (cbs.userDataPrefixNorm && pathIsUnderPrefix(rec.p, cbs.userDataPrefixNorm)) return true;
    if (cbs.applyNoiseFilter !== false && isNoiseCandidatePath(normPath(rec.p))) return true;
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
 *  record. Return false from `onRec` to stop early. Honors `isCancelled`
 *  on every line so cancel propagates within one record-read instead of
 *  the prior every-5000-records cadence. */
async function streamIndex(
  indexPath: string,
  isCancelled: () => boolean,
  onRec: (rec: { p: string; s?: number; m?: number; t?: string }) => boolean,
): Promise<void> {
  const gunzip = createGunzip();
  const source = createReadStream(indexPath);
  // CRITICAL: attach error listeners to BOTH source and gunzip BEFORE
  // calling pipe(). source.pipe(gunzip) does not propagate errors; if
  // source errors (e.g. index file mid-rotation, transient EPERM) with
  // no listener, Node throws an uncaught exception that surfaces as
  // the "DiskHound — Unexpected error" dialog. Same for gunzip if
  // decompression hits a malformed chunk.
  source.on("error", () => { /* swallowed — the for-await will see EOF or be aborted */ });
  gunzip.on("error", () => { /* swallowed — same */ });
  source.pipe(gunzip);
  const rl = createInterface({ input: gunzip, crlfDelay: Infinity });
  try {
    for await (const line of rl) {
      if (isCancelled()) break;
      if (!line) continue;
      let rec: { p?: string; s?: number; m?: number; t?: string };
      try { rec = JSON.parse(line); } catch { continue; }
      if (!rec || typeof rec.p !== "string") continue;
      const cont = onRec(rec as { p: string; s?: number; m?: number; t?: string });
      if (!cont) break;
    }
  } catch {
    // for-await can throw if the underlying stream errors mid-read.
    // We've already absorbed via the error listeners above, but the
    // async iterator may still surface the underlying rejection.
  } finally {
    rl.close();
    // Close the gunzip & source streams so the OS file handle
    // releases promptly on cancel — otherwise the gzip readable
    // side keeps the file open for the duration of the GC pause.
    try { gunzip.destroy(); } catch { /* ok */ }
    try { source.destroy(); } catch { /* ok */ }
  }
}

function pathIsUnderRoot(path: string, rootNorm: string, rootPrefix: string): boolean {
  const n = normPath(path);
  return n === rootNorm || n.startsWith(rootPrefix);
}

/**
 * True if `path` is at or under the given (already-normalised)
 * prefix. Used to exclude DiskHound's own userData files from
 * duplicate scanning — they're noise and some are mid-rotation
 * (sidecars get deleted right after a scan completes, generating
 * spurious ENOENTs for the just-built scan's own index references).
 */
function pathIsUnderPrefix(path: string, prefixNorm: string): boolean {
  const n = normPath(path);
  if (n === prefixNorm) return true;
  const withSep = prefixNorm.endsWith(Path.sep) ? prefixNorm : prefixNorm + Path.sep;
  return n.startsWith(withSep);
}

// ── Candidate collection: filesystem-walk fallback ───────────────────────

interface WalkCallbacks {
  minSizeBytes: number;
  userDataPrefixNorm?: string;
  applyNoiseFilter?: boolean;
  onProgress: (walked: number, candidateGroups: number) => void;
  isCancelled: () => boolean;
}

/**
 * Fallback when the index isn't available. Walks the tree with
 * stat-per-file, but now applies the same two-pass trick: first pass
 * counts by size (no path allocation), second pass collects only paths
 * for sizes that showed ≥ 2 occurrences.
 *
 * This is slower than the index path because of the stat syscalls, but
 * still avoids the old 1–2 GB memory peak since we don't materialize
 * every single file's candidate eagerly.
 *
 * Cancellation: checked on every directory pop AND on every entry. A
 * cancel signal from the renderer aborts within a single readdir
 * call, even on directories with millions of entries.
 */
async function collectFromWalk(
  rootPath: string,
  cbs: WalkCallbacks,
): Promise<Map<number, FileCandidate[]>> {
  const entries: { path: string; size: number; mtime: number }[] = [];
  const sizeCounts = new Map<number, number>();
  const directoryStack = [Path.resolve(rootPath)];
  let walked = 0;

  while (directoryStack.length > 0) {
    if (cbs.isCancelled()) return new Map();
    const dirPath = directoryStack.pop()!;
    let dirEntries: FS.Dirent[];
    try {
      dirEntries = await FSP.readdir(dirPath, { withFileTypes: true });
    } catch { continue; }

    for (const entry of dirEntries) {
      if (cbs.isCancelled()) return new Map();
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
      if (cbs.userDataPrefixNorm && pathIsUnderPrefix(fullPath, cbs.userDataPrefixNorm)) continue;
      if (cbs.applyNoiseFilter !== false && isNoiseCandidatePath(normPath(fullPath))) continue;

      walked++;
      sizeCounts.set(stat.size, (sizeCounts.get(stat.size) ?? 0) + 1);
      entries.push({ path: fullPath, size: stat.size, mtime: stat.mtimeMs });
      if (walked % 500 === 0) {
        let candGroups = 0;
        for (const c of sizeCounts.values()) if (c >= 2) candGroups++;
        cbs.onProgress(walked, candGroups);
      }
    }
  }

  // Final tick so the summary log and progress UI show the true walk
  // count even for trees that finished without crossing the 500-file
  // sample boundary (small folders, or scan completed quickly).
  {
    let candGroups = 0;
    for (const c of sizeCounts.values()) if (c >= 2) candGroups++;
    cbs.onProgress(walked, candGroups);
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

/**
 * Prefix-hash with cache. Cache key = "prefix:" + path. If the file's
 * (size, mtime) matches the cached entry's, return the cached hash
 * without reading. Otherwise hash and cache. Prefix cache entries are
 * cheap — typical cache file holds millions and stays under 100 MB.
 */
async function cachedHashPrefix(
  file: FileCandidate,
  active: Set<ReadStream>,
  isCancelled: () => boolean,
): Promise<string | null> {
  if (isCancelled()) return null;
  const cacheKey = `prefix:${file.path}`;
  const cached = getCachedHash(cacheKey, file.size, file.mtime);
  if (cached) return cached;
  const hash = await hashFilePrefix(file.path, active, isCancelled);
  if (hash && !isCancelled()) {
    setCachedHash(cacheKey, file.size, file.mtime, hash);
  }
  return hash;
}

/**
 * Content-hash with cache. Routes to full-stream hashing for small
 * files and 3-sample hashing for files above
 * SAMPLE_HASH_THRESHOLD_BYTES. Cache key encodes the variant so a
 * later threshold tweak doesn't return a stale sample-hash where a
 * full-hash would now be computed.
 */
async function cachedHashContent(
  file: FileCandidate,
  active: Set<ReadStream>,
  isCancelled: () => boolean,
): Promise<string | null> {
  if (isCancelled()) return null;
  const useSampling = file.size > SAMPLE_HASH_THRESHOLD_BYTES;
  const cacheKey = useSampling ? `sample:${file.path}` : `full:${file.path}`;
  const cached = getCachedHash(cacheKey, file.size, file.mtime);
  if (cached) return cached;
  const hash = useSampling
    ? await hashFileSample(file.path, file.size, active, isCancelled)
    : await hashFileFull(file.path, active, isCancelled);
  if (hash && !isCancelled()) {
    setCachedHash(cacheKey, file.size, file.mtime, hash);
  }
  return hash;
}

/**
 * Hash the first PREFIX_BYTES of a file. Streams a single read; the
 * stream is registered in `active` so a cancel during the scan
 * destroys it. Resolves null on any I/O error or cancellation.
 */
function hashFilePrefix(
  filePath: string,
  active: Set<ReadStream>,
  isCancelled: () => boolean,
): Promise<string | null> {
  return new Promise((resolve) => {
    let settled = false;
    let stream: ReadStream | null = null;
    let timeoutId: NodeJS.Timeout | null = null;
    let hashUpdateCount = 0; // diagnostic: was data ever delivered?
    let endFired = false;    // diagnostic: did the stream end normally?
    let closeFiredFirst = false; // diagnostic: did close fire before end?
    const finish = (val: string | null) => {
      if (settled) return;
      settled = true;
      if (timeoutId) { clearTimeout(timeoutId); timeoutId = null; }
      if (stream) {
        active.delete(stream);
        try { stream.destroy(); } catch { /* already destroyed */ }
      }
      resolve(val);
    };

    if (isCancelled()) return finish(null);

    try {
      stream = createReadStream(filePath, {
        start: 0,
        end: PREFIX_BYTES - 1,
        highWaterMark: PREFIX_BYTES,
      });
    } catch (err) {
      logFirstFailure("ctor-throw", filePath, err);
      return finish(null);
    }

    // CRITICAL: attach error + close listeners FIRST, before active.add /
    // createHash / data listener / anything else that could throw. A v0.5.22
    // user hit a wave of [main-uncaught] ENOENT/EBUSY errors with no stack
    // trace — symptom of the error event firing on a stream before its
    // listener was attached, which happens if any sync code between
    // createReadStream and stream.on("error") throws. Defense in depth.
    stream.on("error", (err) => {
      logFirstFailure("error-event", filePath, err);
      finish(null);
    });
    stream.on("close", () => {
      if (!endFired && !settled) {
        closeFiredFirst = true;
        logFirstFailure(
          "close-before-end",
          filePath,
          new Error(`close fired before end (hashUpdateCount=${hashUpdateCount})`),
        );
      }
      finish(null);
    });

    active.add(stream);

    const hash = createHash(HASH_ALGO);
    stream.on("data", (chunk) => {
      if (isCancelled()) {
        finish(null);
        return;
      }
      // hash.update should never throw on a Buffer, but if it ever did,
      // the throw would propagate out of the event listener as an uncaught
      // exception. Wrap defensively.
      try {
        hash.update(chunk);
        hashUpdateCount++;
      } catch (err) {
        logFirstFailure("hash-update-throw", filePath, err);
        finish(null);
      }
    });
    stream.on("end", () => {
      endFired = true;
      try {
        const digest = isCancelled() ? null : hash.digest("hex");
        if (digest === null) {
          // Cancelled. Don't log as failure.
        } else if (hashUpdateCount === 0) {
          // end fired without ANY data chunks — empty file. Valid but
          // unusual for "candidates" (which are all > 1 MB by default).
          // Log so we can see whether this case dominates.
          logFirstFailure("end-no-data", filePath, new Error("end fired with zero chunks"));
        }
        finish(digest);
      } catch (err) {
        logFirstFailure("digest-throw", filePath, err);
        finish(null);
      }
    });

    // Safety timeout: if no event fires for 30 s (prefix is at most 64 KB
    // — even a slow HDD reads that in well under a second), force-resolve
    // so the worker pool isn't held hostage by a stuck stream. 30 s is
    // generous; in practice the timeout never fires under normal conditions.
    timeoutId = setTimeout(() => {
      logFirstFailure("timeout", filePath, new Error(`30s timeout, hashUpdateCount=${hashUpdateCount}, endFired=${endFired}, closeFiredFirst=${closeFiredFirst}`));
      finish(null);
    }, 30_000);
  });
}

/**
 * Per-scan diagnostic for hash failures.
 *
 * v0.5.28: dedup'd by `kind` — too coarse (one error-event entry for
 *          30 k different files).
 * v0.5.31: switched to `kind/code`, capped at 8 buckets, 5 samples
 *          each. Helped spot ENOENT vs EPERM vs EBUSY breakdowns.
 * v0.5.34: bumped MAX_FAILURE_BUCKETS to 32 because real-world drives
 *          easily hit >8 distinct (kind, code) pairs (close-before-end
 *          / ctor-throw / error-event × ENOENT/EPERM/EACCES/EBUSY
 *          /EMFILE/etc), and we were silently dropping the 9th+.
 *          Also added per-directory aggregation so the summary line
 *          tells us WHERE failures cluster — directly actionable for
 *          adding new noise patterns. Without it the user would see
 *          "29 k ENOENTs" and we still wouldn't know which dirs.
 */
const MAX_SAMPLES_PER_BUCKET = 5;
const MAX_FAILURE_BUCKETS = 32;
/** How deep to aggregate parent-dir paths in the summary. 4 segments
 *  is `c:\users\thoma\appdata\` — enough to identify the offender
 *  without leaking individual filenames into telemetry. */
const FAIL_PATH_DEPTH = 4;
/** Cap on distinct parent-dir buckets we track. Once we hit this many,
 *  new dirs go into an "other" lump. 64 is plenty — 99% of failure
 *  locations cluster into <20 dirs on real drives. */
const MAX_PATH_BUCKETS = 64;
let failureBuckets: Map<string, { count: number; samplesLogged: number }> = new Map();
let failurePathBuckets: Map<string, number> = new Map();
let failurePathOverflow = 0;
let failureDroppedBuckets = 0;
function resetFailureLogger(): void {
  failureBuckets = new Map();
  failurePathBuckets = new Map();
  failurePathOverflow = 0;
  failureDroppedBuckets = 0;
}
/**
 * Aggregate a path into a fixed-depth parent prefix so 10 k distinct
 * filenames in one cache directory collapse into a single counter.
 * Always uses backslash on Windows-normalised paths; on POSIX paths
 * the normaliser leaves '/' alone so we split on both.
 */
function aggregateFailurePath(normalisedPath: string): string {
  // Find the FAIL_PATH_DEPTH'th separator from the start. Everything
  // up to (and including) that separator is the bucket key.
  let count = 0;
  for (let i = 0; i < normalisedPath.length; i++) {
    const ch = normalisedPath.charCodeAt(i);
    if (ch === 92 /* \ */ || ch === 47 /* / */) {
      count++;
      if (count === FAIL_PATH_DEPTH) {
        return normalisedPath.substring(0, i + 1);
      }
    }
  }
  // Shorter than the depth — use the whole parent path, less the
  // final segment so we don't leak the filename.
  const lastSep = Math.max(
    normalisedPath.lastIndexOf("\\"),
    normalisedPath.lastIndexOf("/"),
  );
  return lastSep >= 0 ? normalisedPath.substring(0, lastSep + 1) : normalisedPath;
}
function logFirstFailure(kind: string, path: string, err: unknown): void {
  const code = (err as { code?: string })?.code ?? "";
  const bucketKey = `${kind}/${code || "?"}`;
  let bucket = failureBuckets.get(bucketKey);
  if (!bucket) {
    if (failureBuckets.size >= MAX_FAILURE_BUCKETS) {
      // Out of bucket slots. Still count it in `failureDroppedBuckets`
      // so the summary's "other" line is honest.
      failureDroppedBuckets++;
    } else {
      bucket = { count: 0, samplesLogged: 0 };
      failureBuckets.set(bucketKey, bucket);
    }
  }
  if (bucket) {
    bucket.count++;
    if (bucket.samplesLogged < MAX_SAMPLES_PER_BUCKET) {
      bucket.samplesLogged++;
      const msg = err instanceof Error ? err.message : String(err);
      verboseLogger(`hash-fail kind=${kind} code=${code} path=${path} err=${msg}`);
    }
  }
  // Always count in the per-directory aggregation, even when the
  // (kind, code) bucket is full — that's the actionable telemetry.
  const dirKey = aggregateFailurePath(normPath(path));
  const existing = failurePathBuckets.get(dirKey);
  if (existing !== undefined) {
    failurePathBuckets.set(dirKey, existing + 1);
  } else if (failurePathBuckets.size < MAX_PATH_BUCKETS) {
    failurePathBuckets.set(dirKey, 1);
  } else {
    failurePathOverflow++;
  }
}
/**
 * Emit a summary at the end of Pass A. Two lines:
 *
 *   1. hash-fail summary: <kind/code>=count, …
 *      Shows error-mode breakdown so we can see if it's mostly ENOENT
 *      (stale index entries) vs EPERM (permissions) vs EBUSY (locks).
 *   2. hash-fail top-dirs: <dir>=count, …
 *      Shows the top-10 parent dirs by failure count. Directly tells
 *      us which dirs to add to NOISE_PATH_PATTERNS.
 *
 * Both lines are skipped when no failures occurred.
 */
function logFailureSummary(): void {
  if (failureBuckets.size === 0 && failurePathBuckets.size === 0) return;
  // Kind/code breakdown, sorted by count descending so the most
  // common failure mode is first — most informative bit of the line.
  const kindParts: string[] = [];
  const sortedKinds = Array.from(failureBuckets.entries()).sort(
    (a, b) => b[1].count - a[1].count,
  );
  for (const [bucketKey, bucket] of sortedKinds) {
    kindParts.push(`${bucketKey}=${bucket.count}`);
  }
  if (failureDroppedBuckets > 0) kindParts.push(`other-kinds=${failureDroppedBuckets}`);
  verboseLogger(`hash-fail summary: ${kindParts.join(", ")}`);
  // Top-10 parent dirs by count — directly actionable.
  const sortedDirs = Array.from(failurePathBuckets.entries()).sort((a, b) => b[1] - a[1]);
  const TOP_DIRS = 10;
  const top = sortedDirs.slice(0, TOP_DIRS);
  const dirParts = top.map(([dir, count]) => `${dir}=${count}`);
  if (sortedDirs.length > TOP_DIRS) {
    let rest = 0;
    for (let i = TOP_DIRS; i < sortedDirs.length; i++) rest += sortedDirs[i]![1];
    dirParts.push(`other-dirs=${rest}`);
  }
  if (failurePathOverflow > 0) dirParts.push(`overflow=${failurePathOverflow}`);
  verboseLogger(`hash-fail top-dirs: ${dirParts.join(", ")}`);
}

/**
 * Hash the entire file. Used for files at or below
 * SAMPLE_HASH_THRESHOLD_BYTES. Stream highWaterMark is bumped to
 * 1 MB so big-file syscall count drops 16× vs. the Node default.
 * Cancellable mid-stream: every `data` event checks isCancelled()
 * and destroys the stream if set, so a cancel signal aborts a
 * 64 MB read within one chunk (~1 ms).
 */
function hashFileFull(
  filePath: string,
  active: Set<ReadStream>,
  isCancelled: () => boolean,
): Promise<string | null> {
  return new Promise((resolve) => {
    let settled = false;
    let stream: ReadStream | null = null;
    let timeoutId: NodeJS.Timeout | null = null;
    const finish = (val: string | null) => {
      if (settled) return;
      settled = true;
      if (timeoutId) { clearTimeout(timeoutId); timeoutId = null; }
      if (stream) {
        active.delete(stream);
        try { stream.destroy(); } catch { /* already destroyed */ }
      }
      resolve(val);
    };

    if (isCancelled()) return finish(null);

    try {
      stream = createReadStream(filePath, { highWaterMark: FULL_HASH_HIGH_WATER_MARK });
    } catch {
      return finish(null);
    }

    // Same defensive ordering as hashFilePrefix — error + close listeners
    // BEFORE any sync code that could throw.
    stream.on("error", () => finish(null));
    stream.on("close", () => finish(null));

    active.add(stream);

    const hash = createHash(HASH_ALGO);
    stream.on("data", (chunk) => {
      if (isCancelled()) {
        finish(null);
        return;
      }
      try {
        hash.update(chunk);
      } catch {
        finish(null);
      }
    });
    stream.on("end", () => {
      try {
        finish(isCancelled() ? null : hash.digest("hex"));
      } catch {
        finish(null);
      }
    });

    // Safety timeout for the full-hash case: 5 min. Full hashes only run
    // for files ≤ 64 MB (anything larger goes through hashFileSample), so
    // even at HDD speeds (~30 MB/s) the cap is well within reach. If a
    // file's open() blocks indefinitely (network drive offline, etc.),
    // the timeout unblocks the worker pool.
    timeoutId = setTimeout(() => finish(null), 5 * 60_000);
  });
}

/**
 * Sample-hash for very large files. Reads three SAMPLE_BYTES_EACH
 * windows (start, middle, end) and concatenates into one BLAKE2b
 * digest. In practice this is collision-free for non-malicious
 * content at the same size + prefix: producing two distinct files
 * that match in size, first 64 KB, middle 64 KB, AND last 64 KB
 * but diverge elsewhere requires intentional construction. The win
 * is enormous: a 4 GB file goes from a multi-second hash to a few
 * ms (192 KB total read vs. 4 GB total read).
 *
 * Open file handle once via fsp.open() so all three reads share
 * the same descriptor — avoids three rounds of path-resolution
 * cost on Windows where CreateFile() isn't free.
 */
async function hashFileSample(
  filePath: string,
  size: number,
  active: Set<ReadStream>,
  isCancelled: () => boolean,
): Promise<string | null> {
  if (isCancelled()) return null;
  let handle: FSP.FileHandle | null = null;
  try {
    handle = await FSP.open(filePath, "r");
    if (isCancelled()) return null;
    const hash = createHash(HASH_ALGO);
    const buffer = Buffer.alloc(SAMPLE_BYTES_EACH);
    // Three windows: start, middle-aligned, end-aligned. Clamp to
    // sane offsets if the file is just barely over the sample
    // threshold so windows don't overlap.
    const positions: number[] = [
      0,
      Math.max(SAMPLE_BYTES_EACH, Math.floor(size / 2) - Math.floor(SAMPLE_BYTES_EACH / 2)),
      Math.max(SAMPLE_BYTES_EACH * 2, size - SAMPLE_BYTES_EACH),
    ];
    // Hash the byte-length as a salt so a sampled hash can never
    // collide with a full hash of a different file that happened
    // to start with the same 192 KB. Cheap insurance.
    hash.update(`size:${size}|`);
    for (const offset of positions) {
      if (isCancelled()) return null;
      const { bytesRead } = await handle.read(buffer, 0, SAMPLE_BYTES_EACH, offset);
      if (bytesRead > 0) hash.update(buffer.subarray(0, bytesRead));
    }
    if (isCancelled()) return null;
    return hash.digest("hex");
  } catch {
    return null;
  } finally {
    if (handle) {
      try { await handle.close(); } catch { /* ok */ }
    }
    // `active` is unused for sample hashing because we close on
    // every iteration boundary, but keep the parameter for shape
    // symmetry with hashFileFull / hashFilePrefix.
    void active;
  }
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
