// ── Scan Types ──────────────────────────────────────────────

export type ScanStatus = "idle" | "running" | "done" | "cancelled" | "error";
export type ScanEngine = "js-worker" | "native-sidecar" | "usn-journal";

export interface ScanFileRecord {
  path: string;
  name: string;
  parentPath: string;
  extension: string;
  size: number;
  modifiedAt: number;
}

export interface DirectoryHotspot {
  path: string;
  size: number;
  fileCount: number;
  depth: number;
}

export interface ExtensionBucket {
  extension: string;
  size: number;
  count: number;
}

export interface ScanOptions {
  // Intentionally empty — scan everything. Kept as a type so the
  // IPC contract signature stays stable for future per-scan toggles.
}

export type ScanPhase =
  | "starting"
  | "reading_metadata"
  | "indexing"
  | "finalizing"
  | "complete";

export interface ScanSnapshot {
  status: ScanStatus;
  engine: ScanEngine;
  rootPath: string | null;
  scanOptions: ScanOptions;
  startedAt: number | null;
  finishedAt: number | null;
  elapsedMs: number;
  filesVisited: number;
  directoriesVisited: number;
  skippedEntries: number;
  bytesSeen: number;
  largestFiles: ScanFileRecord[];
  hottestDirectories: DirectoryHotspot[];
  topExtensions: ExtensionBucket[];
  errorMessage: string | null;
  lastUpdatedAt: number;
  /** Coarse phase within a running scan; used by the UI to pick the
   *  right status text and progress-bar denominator. Optional because
   *  older snapshots (walker path, pre-0.3.15) don't populate it. */
  scanPhase?: ScanPhase;
  /** Total file count the scanner expects to emit, set once the MFT
   *  fast path has counted records. Lets the UI draw a files-based
   *  progress bar during the `indexing` phase where byte-based progress
   *  stalls at ~98% because records are pre-sorted biggest-first. */
  expectedTotalFiles?: number | null;
}

export interface PathActionResult {
  ok: boolean;
  message: string;
}

export interface ScanStartInput {
  rootPath: string;
  options: ScanOptions;
  /**
   * Optional scanner knobs. Not user-configurable — the scanner uses
   * generous internal defaults so the UI "just works" without tuning.
   */
  limits?: {
    topFileLimit: number;
    topDirectoryLimit: number;
  };
  /** If set, scanner writes a gzipped NDJSON index of every file to this path. */
  indexOutput?: string;
  /**
   * Optional path to a previous scan's gzipped NDJSON index. When provided,
   * the scanner skips re-walking directories whose mtime matches the
   * baseline's — inheriting file data from the baseline instead. Typical
   * speedup on a mostly-idle drive: 10-50× after the first scan.
   *
   * The baseline index must contain directory mtime entries (written by
   * scanners v0.2.5+). Older indexes without dir entries fall back to a
   * full walk automatically.
   */
  baselineIndex?: string;
  /**
   * Optional sidecar output path. When set the scanner writes a
   * pre-built folder-tree JSON.gz alongside the NDJSON index. Node
   * loads this file directly on Folders-tab open instead of
   * re-streaming the index through a worker — drops 5+ min load +
   * 4-8 GB of worker memory down to a sub-second JSON.parse.
   */
  folderTreeOutput?: string;
}

export type WorkerToMainMessage =
  | { type: "progress"; snapshot: ScanSnapshot }
  | { type: "done"; snapshot: ScanSnapshot }
  | { type: "error"; message: string };

export type MainToWorkerMessage = { type: "start"; input: ScanStartInput };

// ── Settings Types ──────────────────────────────────────────

export interface AppSettings {
  general: GeneralSettings;
  scanning: ScanningSettings;
  monitoring: MonitoringSettings;
  notifications: NotificationSettings;
  cleanup: CleanupSettings;
  recentScans: RecentScan[];
  /** Persistent CPU-affinity rules. Every process-monitor sample
   *  checks running processes against these rules and re-applies the
   *  mask if the process has drifted off-rule (either the OS restarted
   *  it with default affinity, or the user's set-affinity action was
   *  overridden by another tool). Matches Process Lasso's "CPU
   *  Affinity Rules" tab semantics. */
  affinityRules: AffinityRule[];
}

export interface AffinityRule {
  /** Stable UUID — used as the React key and for IPC identity. */
  id: string;
  /** Human-readable label, defaults to the exe basename. */
  name: string;
  /** Disable without deleting — useful for "pause" during debugging. */
  enabled: boolean;
  /** "exe_name" matches on the basename only (e.g. `chrome.exe`, case-
   *  insensitive). "exe_path" matches the full path (case-insensitive,
   *  substring match so a user can pin by project directory). */
  matchType: "exe_name" | "exe_path";
  /** The pattern — exact basename for `exe_name`, substring for
   *  `exe_path`. Stored lowercased at save time so match-time checks
   *  don't need to re-case. */
  matchPattern: string;
  /** Bitmask of allowed logical CPUs. Bit N means CPU N is enabled.
   *  JavaScript number precision is 53-bit; sufficient for up to 53
   *  logical CPUs which comfortably covers all currently-shipping
   *  consumer + most server hardware. */
  affinityMask: number;
  /** Wall-clock ms at rule creation. Drives "created 3d ago" UI
   *  and lets the user sort oldest/newest. */
  createdAt: number;
  /** Wall-clock ms of the last successful `SetProcessAffinityMask`
   *  application via this rule. Null if the rule has never fired. */
  lastAppliedAt: number | null;
  /** Monotonic counter of successful applications across the rule's
   *  lifetime. Useful signal ("this rule fires 200×/day → maybe the
   *  process is fighting us"). */
  appliedCount: number;
}

export interface RecentScan {
  path: string;
  scannedAt: number;
  filesFound: number;
  bytesFound: number;
}

export interface GeneralSettings {
  minimizeToTray: boolean;
  startMinimized: boolean;
  launchOnStartup: boolean;
  theme: "dark" | "light" | "system";
  autoUpdate: boolean;
  /**
   * When true, swap red/green-heavy color cues for an Okabe-Ito-derived
   * palette (orange, sky blue, bluish-green, yellow, blue, vermillion,
   * reddish purple). Affects treemap extension colors, folder subtree
   * bars, Changes delta positive/negative, scan-status dots, drive-pill
   * free-space bars, and risk indicators — every place where we'd
   * otherwise rely on red/green to communicate meaning.
   */
  colorBlindMode: boolean;
}

export interface ScanningSettings {
  defaultRootPath: string;
}

export interface MonitoringSettings {
  enabled: boolean;
  checkIntervalMinutes: number;
  alertThresholdBytes: number; // alert when free space drops by this much
  alertThresholdPercent: number; // or by this percentage
  fullScanIntervalMinutes: number; // periodic full re-scan (in minutes)
  requireIdle: boolean; // only scan when system is idle
  idleMinutes: number; // how long idle before scanning
  /**
   * Drive identifiers (e.g. "C:", "D:") the user has opted out of
   * monitoring. When empty (default) every drive discovered by the
   * monitor is tracked. Takes effect only when `enabled` is true —
   * disabling monitoring globally still overrides per-drive opt-in.
   */
  excludedDrives: string[];
}

export interface NotificationSettings {
  scanComplete: boolean;
  deltaAlerts: boolean;
}

export interface CleanupSettings {
  autoDetectTempFiles: boolean;
  autoDetectCaches: boolean;
  autoDetectOldDownloads: boolean;
  oldFileThresholdDays: number;
  safeDeleteToTrash: boolean; // always use trash instead of permanent delete
}

// ── Monitoring / Delta Types ────────────────────────────────

export interface DiskSpaceInfo {
  drive: string;
  totalBytes: number;
  freeBytes: number;
  usedBytes: number;
  usedPercent: number;
  timestamp: number;
}

export interface DiskDelta {
  drive: string;
  previousFreeBytes: number;
  currentFreeBytes: number;
  deltaBytes: number; // negative = space decreased
  deltaPercent: number;
  measuredAt: number;
}

export interface MonitoringSnapshot {
  drives: DiskSpaceInfo[];
  deltas: DiskDelta[];
  lastFullScanAt: number | null;
  lastCheckedAt: number;
}

/** Scan-schedule metadata surfaced by the main process for the Changes tab. */
export interface ScanScheduleInfo {
  /** Whether background monitoring is currently enabled. */
  enabled: boolean;
  /** Minutes between scheduled full scans. 0 means disabled. */
  intervalMinutes: number;
  /** Epoch ms of the last completed full scan (any root). */
  lastScanAt: number | null;
  /** Epoch ms of the next expected scheduled scan, or null if disabled/unknown. */
  nextScanAt: number | null;
  /** Configured default scan path (may be empty). */
  defaultRootPath: string;
}

// ── AI Cleanup Suggestion Types ─────────────────────────────

export type SuggestionRisk = "safe" | "low" | "medium" | "high";
export type SuggestionCategory =
  | "temp-files"
  | "build-cache"
  | "package-cache"
  | "old-downloads"
  | "large-media"
  | "duplicates"
  | "logs"
  | "browser-cache"
  | "system-cache"
  | "installer-leftovers";

export interface CleanupSuggestion {
  id: string;
  category: SuggestionCategory;
  risk: SuggestionRisk;
  title: string;
  description: string;
  paths: string[];
  totalSize: number;
  fileCount: number;
  reasoning: string;
}

export interface CleanupAnalysis {
  suggestions: CleanupSuggestion[];
  totalReclaimableBytes: number;
  analyzedAt: number;
  scanRootPath: string;
}

// ── Treemap Types ───────────────────────────────────────────

export interface TreemapNode {
  path: string;
  name: string;
  size: number;
  extension?: string;
  children?: TreemapNode[];
  depth: number;
  isDirectory: boolean;
}

// ── Notification Types ──────────────────────────────────────

export type ToastLevel = "info" | "success" | "warning" | "error";

export interface ToastMessage {
  id: string;
  level: ToastLevel;
  title: string;
  body?: string;
  dismissAfterMs?: number;
}

// ── Easy Move (symlink) Types ─────────────────────────────

export interface EasyMoveRecord {
  id: string;
  originalPath: string;
  movedToPath: string;
  symlinkPath: string; // same as originalPath — the symlink replaces it
  size: number;
  movedAt: number;
  isDirectory: boolean;
  /** True when file was moved but linking failed AND rollback also failed.
   *  The file is at `movedToPath` with no link at `originalPath`. */
  stranded?: boolean;
}

export interface EasyMoveResult {
  ok: boolean;
  message: string;
  record?: EasyMoveRecord;
  /**
   * Set when the move failed because the source path requires admin
   * rights to stat / move (Windows-protected paths like
   * \Windows\LiveKernelReports, \Windows\System32 debug dumps, etc.).
   * Renderer detects this and offers a "Retry with admin" prompt; if
   * accepted it calls `easyMoveElevated` which spawns a single
   * UAC-elevated PowerShell that performs the move + link creation.
   */
  requiresElevation?: boolean;
}

// ── Scan Diff Types ────────────────────────────────────────

export interface ScanHistoryEntry {
  id: string;
  rootPath: string;
  scannedAt: number;
  filesVisited: number;
  directoriesVisited: number;
  bytesSeen: number;
  elapsedMs: number;
  /** Which scanner produced this entry. Optional for backward-compat with
   *  history written before v0.2.8 — older entries are treated as full. */
  engine?: ScanEngine;
}

export type FileDeltaKind = "added" | "removed" | "grew" | "shrank";

export interface FileDelta {
  path: string;
  name: string;
  extension: string;
  kind: FileDeltaKind;
  /** Current size (0 for removed files) */
  size: number;
  /** Previous size (0 for added files) */
  previousSize: number;
  /** size - previousSize */
  deltaBytes: number;
}

export type DirDeltaKind = "added" | "removed" | "grew" | "shrank";

export interface DirectoryDelta {
  path: string;
  kind: DirDeltaKind;
  size: number;
  previousSize: number;
  deltaBytes: number;
  fileCount: number;
  previousFileCount: number;
}

export interface ExtensionDelta {
  extension: string;
  size: number;
  previousSize: number;
  deltaBytes: number;
  count: number;
  previousCount: number;
}

export interface ScanDiffResult {
  /** ID of the baseline (older) snapshot */
  baselineId: string;
  baselineScannedAt: number;
  /** ID of the current (newer) snapshot */
  currentId: string;
  currentScannedAt: number;
  rootPath: string;

  // ── Aggregate deltas (reliable — derived from full scan totals) ──
  totalBytesDelta: number;
  totalFilesDelta: number;
  totalDirsDelta: number;
  previousBytesSeen: number;
  currentBytesSeen: number;

  // ── Itemized deltas (top-N limited — see note) ──
  fileDeltas: FileDelta[];
  directoryDeltas: DirectoryDelta[];
  extensionDeltas: ExtensionDelta[];

  /** Elapsed time between the two scans */
  timeBetweenMs: number;
}

// ── Full File-Index Diff Types ─────────────────────────────
// Built from the complete file index (every file seen), not top-N.

export type FullFileChangeKind = "added" | "removed" | "grew" | "shrank";

export interface FullFileChange {
  path: string;
  kind: FullFileChangeKind;
  size: number;
  previousSize: number;
  deltaBytes: number;
}

export interface FullDiffResult {
  baselineId: string;
  currentId: string;
  totalChanges: number;
  totalAdded: number;
  totalRemoved: number;
  totalGrew: number;
  totalShrank: number;
  totalBytesAdded: number;
  totalBytesRemoved: number;
  /** Sorted by absolute deltaBytes descending. Capped at a configurable limit. */
  changes: FullFileChange[];
  /** True when more changes exist than are included in `changes`. */
  truncated: boolean;
}

export interface FullDiffStatus {
  baselineId: string;
  currentId: string;
  limit: number;
  cached: boolean;
  baselineIndexBytes: number | null;
  currentIndexBytes: number | null;
}

// ── Process / Memory Types ─────────────────────────────────

export interface ProcessInfo {
  pid: number;
  name: string;
  /** Resident set size in bytes (real RAM used) */
  memoryBytes: number;
  /**
   * CPU percent when available — SYSTEM-WIDE, 0–100 across all cores.
   * Matches what Task Manager / Activity Monitor show. Computed as
   * (cpu-time-delta / wall-clock-delta) / cpuCount * 100.
   */
  cpuPercent: number | null;
  /**
   * CPU percent as a fraction of a single core. 200% means the process
   * used 2 full cores' worth of compute between samples. Can exceed 100%
   * on multi-threaded workloads. Preferred by some power users who want
   * to see absolute per-core load rather than relative system share.
   */
  cpuPercentPerCore: number | null;
  /** True when the user owns the process. On Windows we can't always tell cheaply — may be true for all. */
  userOwned: boolean;
  /** Full command line or executable path, when we can get it. */
  commandLine?: string;
  /** Full path to the executable, when known. Used for icon resolution. */
  exePath?: string | null;
  /** Cumulative CPU time in ms — used to compute cpuPercent between samples. */
  cpuTimeMs?: number;
}

export interface SystemMemorySnapshot {
  totalBytes: number;
  freeBytes: number;
  usedBytes: number;
  usedPercent: number;
  /** Number of logical CPU cores */
  cpuCount: number;
  /** 1m load average (Unix) or null on Windows. */
  loadAvg: number | null;
  processes: ProcessInfo[];
  sampledAt: number;
  errorMessage?: string;
  /** True when this snapshot came from cache and is being refreshed. */
  isStale?: boolean;
  /** Elapsed ms the most recent sample took — useful for UX feedback. */
  sampleElapsedMs?: number;
}

export type KillSignal = "soft" | "hard";

// ── GPU ─────────────────────────────────────────────────────
//
// GPU stats are collected per-adapter and per-process from Windows
// performance counters (\GPU Engine\*, \GPU Adapter Memory\*,
// \GPU Process Memory\*) plus Win32_VideoController via
// Get-CimInstance. Sampled on the same cadence as memory; a single
// PowerShell invocation returns all three counter families at once.
//
// Engine types we aggregate (from the NVIDIA/AMD/Intel WDDM 2.0
// scheduler): "3D" (shader + rasterization), "Compute", "VideoDecode",
// "VideoEncode", "Copy". Each shows up as separate GPU Engine
// counter instances; we sum per-PID for "utilisation".

/** A physical or virtual GPU as reported by Windows. */
export interface GpuAdapter {
  /** Stable identifier used to correlate per-process counters with
   *  adapters. Parsed from the GPU Adapter Memory counter's LUID
   *  substring ("luid_0x00000000_0x00064B70"). */
  id: string;
  /** Vendor-friendly name from Win32_VideoController (e.g. "NVIDIA GeForce RTX 4070"). */
  name: string;
  /** Driver version string, when available. */
  driverVersion: string | null;
  /** Total dedicated (VRAM) capacity advertised by the adapter.
   *  Null if we couldn't read it (older drivers, integrated GPUs
   *  sharing system memory, etc.). */
  dedicatedBytesTotal: number | null;
  /** Currently-used dedicated (VRAM) bytes across all processes on
   *  this adapter — sum of \GPU Adapter Memory\Dedicated Usage. */
  dedicatedBytesUsed: number;
  /** Currently-used shared-system memory bytes across all processes. */
  sharedBytesUsed: number;
  /** Engine-utilisation summary: per engine type, the share of that
   *  engine's time spent running work. 0-100. Engines with no
   *  scheduled work don't appear in this map. */
  enginePercent: Record<string, number>;
  /** Overall utilisation — usually the max across all engine types,
   *  since "how busy is the GPU" is dominated by whichever pipeline
   *  is saturated. */
  utilizationPercent: number;
}

/** Per-process GPU usage for a single Windows process. */
export interface GpuProcessInfo {
  pid: number;
  /** Process name as pulled from the matching Get-Process entry, so
   *  the GPU tab and Processes tab agree on labels. */
  name: string;
  /** Full path to the executable, when resolvable. Used for icons. */
  exePath: string | null;
  /** Adapter this process is using. Null when the process uses
   *  multiple adapters or we couldn't correlate (rare). */
  adapterId: string | null;
  /** Dedicated VRAM bytes this process has allocated on the GPU. */
  dedicatedBytes: number;
  /** Shared system memory the GPU driver is using on this process's behalf. */
  sharedBytes: number;
  /** Per-engine utilisation percent (0-100 per engine). Only
   *  engines actually used by the process appear. */
  enginePercent: Record<string, number>;
  /** Headline GPU utilisation — max across engine types for this
   *  process. Sorted-by default. */
  utilizationPercent: number;
}

/** Full GPU sample: adapters + processes. Matches the memory-snapshot
 *  shape so MemoryView's existing cadence and cache machinery can be
 *  reused for GPU without a whole second poll loop. */
export interface GpuSnapshot {
  adapters: GpuAdapter[];
  processes: GpuProcessInfo[];
  sampledAt: number;
  /** Elapsed ms the sample took — useful UX feedback when GPU
   *  sampling is slow (some systems take 800-1500ms for Get-Counter). */
  sampleElapsedMs: number;
  /** True on machines with no WDDM-capable adapter (rare: older
   *  integrated-only + no WDDM 2.0 driver). Lets the UI show a
   *  "GPU stats not available on this machine" empty state. */
  unavailable?: boolean;
  errorMessage?: string;
}

// ── Auto-Update Types ──────────────────────────────────────

export type UpdatePhase = "idle" | "checking" | "available" | "downloading" | "downloaded" | "up-to-date" | "error";

export interface UpdateStatus {
  phase: UpdatePhase;
  currentVersion: string;
  availableVersion?: string;
  downloadPercent?: number;
  errorMessage?: string;
  /** Epoch ms of the last successful check attempt (available / up-to-date / error).
   *  Persists across app restarts so the Settings UI doesn't say "Never checked"
   *  after a cold boot that's about to trigger a check. */
  lastCheckedAt?: number | null;
}

export interface UpdateState {
  lastCheckedAt: number | null;
  currentVersion: string;
}

// ── Duplicate Detection Types ──────────────────────────────

export type DuplicateScanStatus = "idle" | "walking" | "hashing" | "done" | "cancelled" | "error";

export interface DuplicateFileEntry {
  path: string;
  name: string;
  parentPath: string;
  modifiedAt: number;
}

export interface DuplicateGroup {
  hash: string;
  size: number;
  files: DuplicateFileEntry[];
}

export interface DuplicateAnalysis {
  groups: DuplicateGroup[];
  totalWastedBytes: number;
  totalGroups: number;
  totalDuplicateFiles: number;
  rootPath: string;
  filesWalked: number;
  filesHashed: number;
  elapsedMs: number;
  analyzedAt: number;
}

export interface DuplicateScanProgress {
  /** The root this progress event belongs to. Routes cleanly in the
   *  renderer when multiple drives have concurrent duplicate scans. */
  rootPath: string;
  status: DuplicateScanStatus;
  filesWalked: number;
  candidateGroups: number;
  filesHashed: number;
  groupsConfirmed: number;
  elapsedMs: number;
  errorMessage: string | null;
  /** "index" when we streamed the persisted scan index (fast path);
   *  "walk" when we fell back to a fresh filesystem walk. */
  source?: "index" | "walk";
  /** Minimum file size in bytes that was considered. Defaults to 1 MB. */
  minSizeBytes?: number;
}

export interface DuplicateScanOptions {
  /**
   * Skip files smaller than this. Most "wasted space" lives in big files
   * anyway, and a 4 KB icon-cache duplicate isn't worth the memory cost
   * of hashing.
   */
  minSizeBytes?: number;
}

// ── View Types ──────────────────────────────────────────────

export type AppView = "overview" | "files" | "folders" | "duplicates" | "easyMove" | "changes" | "memory" | "settings";

// ── IPC API ─────────────────────────────────────────────────

export interface DiskhoundNativeApi {
  // Scan
  pickRootPath: () => Promise<string | null>;
  getCurrentSnapshot: () => Promise<ScanSnapshot>;
  startScan: (rootPath: string, options: ScanOptions) => Promise<ScanSnapshot>;
  /** Cancel a specific root's active scan, or (omit rootPath) cancel all. */
  cancelScan: (rootPath?: string) => Promise<ScanSnapshot | null>;
  /** Returns the rootPaths of scans currently running. Used by the UI to
   *  show per-drive progress indicators and skip re-triggering in-flight
   *  scans. */
  getActiveScanRoots: () => Promise<string[]>;
  runScheduledScanNow: () => Promise<PathActionResult>;
  /** Returns a data-URL PNG of the OS-provided file icon, or null if unavailable. */
  getFileIcon: (path: string, size?: "small" | "normal" | "large") => Promise<string | null>;

  // Process / memory viewer
  getMemorySnapshot: () => Promise<SystemMemorySnapshot>;
  /** Returns the last sampled snapshot without triggering a fresh sample —
   *  use for instant paint on tab switch. Returns null on cold boot. */
  getCachedMemorySnapshot: () => Promise<SystemMemorySnapshot | null>;
  /** Sample per-process GPU usage + adapter stats from Windows perf
   *  counters. Takes ~500-1500 ms via a single PowerShell command
   *  (Get-Counter is the bottleneck). Safe to call on non-Windows —
   *  returns `unavailable: true` so the UI can render an empty state. */
  getGpuSnapshot: () => Promise<GpuSnapshot>;
  /** Last sampled GPU snapshot without triggering a refresh. */
  getCachedGpuSnapshot: () => Promise<GpuSnapshot | null>;
  killProcess: (pid: number, signal: KillSignal) => Promise<PathActionResult>;
  /** Read the current CPU affinity mask for a process. Bit N set means
   *  the process is allowed to run on logical processor N. cpuCount
   *  returned alongside so the UI can render the right number of
   *  checkboxes. */
  getCpuAffinity: (pid: number) => Promise<{
    ok: boolean;
    affinityMask?: number;
    cpuCount: number;
    message?: string;
  }>;
  /** Set the affinity mask. Requires the process to be owned by the
   *  current user (or the app to be elevated). */
  setCpuAffinity: (pid: number, mask: number) => Promise<PathActionResult>;
  /** Enumerate persistent affinity rules (stored in settings). */
  getAffinityRules: () => Promise<AffinityRule[]>;
  /** Create or update a rule (matched by `id`). */
  upsertAffinityRule: (rule: AffinityRule) => Promise<{ ok: boolean; message?: string }>;
  /** Delete a rule by id. */
  deleteAffinityRule: (id: string) => Promise<{ ok: boolean; message?: string }>;
  /** Icon for a specific executable, keyed by full path (unlike
   *  getFileIcon which keys by extension — each .exe typically has its
   *  own unique icon). */
  getExecutableIcon: (path: string, size?: "small" | "normal" | "large") => Promise<string | null>;

  // Path actions
  revealPath: (targetPath: string) => Promise<PathActionResult>;
  openPath: (targetPath: string) => Promise<PathActionResult>;
  trashPath: (targetPath: string) => Promise<PathActionResult>;
  permanentlyDeletePath: (targetPath: string) => Promise<PathActionResult>;

  // Settings
  getSettings: () => Promise<AppSettings>;
  updateSettings: (settings: AppSettings) => Promise<void>;
  getRecentScans: () => Promise<RecentScan[]>;

  // Monitoring
  getMonitoringSnapshot: () => Promise<MonitoringSnapshot>;
  getDiskSpace: () => Promise<DiskSpaceInfo[]>;
  /** Rolling timeline of drive-level free-space deltas (newest first). */
  getDiskDeltaHistory: () => Promise<DiskDelta[]>;
  /** Schedule info for the Changes tab — last scan, next scan, interval, etc. */
  getScanScheduleInfo: () => Promise<ScanScheduleInfo>;

  // Elevation / fast-scan admin
  /** Is the current process running elevated, and is the "always elevated"
   *  scheduled task already registered? Drives the first-run admin banner
   *  and Settings → Performance section. */
  getElevationStatus: () => Promise<{ elevated: boolean; scheduledTaskRegistered: boolean }>;
  /** Spawn a UAC-elevated replacement instance and quit the current one.
   *  Resolves once PowerShell has handed off to ShellExecute (before UAC
   *  actually prompts) — the app will call app.quit() shortly after. */
  relaunchAsAdmin: () => Promise<{ ok: boolean; message?: string }>;
  /** One-time opt-in: register a Scheduled Task with HighestAvailable
   *  RunLevel so future launches through `runScheduledTask` skip UAC. */
  registerScheduledTask: () => Promise<{ ok: boolean }>;
  unregisterScheduledTask: () => Promise<{ ok: boolean }>;
  /** Launch DiskHound elevated via the previously-registered scheduled
   *  task — zero UAC prompts. Quits the current process on success.
   *  On failure returns a `message` carrying schtasks's own error text
   *  (e.g. "The system cannot find the file specified" when the task
   *  points at a stale exe path after a reinstall). */
  runScheduledTask: () => Promise<{ ok: boolean; message?: string }>;

  // Cleanup analysis
  analyzeCleanup: (rootPath: string, files: ScanFileRecord[], dirs: DirectoryHotspot[]) => Promise<CleanupAnalysis>;

  // Easy Move
  easyMove: (sourcePath: string, destinationDir: string) => Promise<EasyMoveResult>;
  /** Like `easyMove` but runs the actual filesystem ops under a
   *  UAC-elevated PowerShell. Triggers ONE UAC prompt per invocation.
   *  Used by the renderer when `easyMove` returns `requiresElevation`. */
  easyMoveElevated: (sourcePath: string, destinationDir: string) => Promise<EasyMoveResult>;
  easyMoveBack: (recordId: string) => Promise<PathActionResult>;
  getEasyMoves: () => Promise<EasyMoveRecord[]>;
  pickMoveDestination: () => Promise<string | null>;

  // Duplicate Detection
  startDuplicateScan: (rootPath: string, options?: DuplicateScanOptions) => Promise<void>;
  /** Cancel a specific root's duplicate scan, or (omit rootPath) cancel all. */
  cancelDuplicateScan: (rootPath?: string) => Promise<void>;
  /** Returns the rootPaths of duplicate scans currently running. */
  getActiveDuplicateScanRoots: () => Promise<string[]>;
  onDuplicateProgress: (listener: (progress: DuplicateScanProgress) => void) => () => void;
  onDuplicateResult: (listener: (result: DuplicateAnalysis) => void) => () => void;

  // Scan History & Diff
  getScanHistory: (rootPath: string) => Promise<ScanHistoryEntry[]>;
  /** Load the most recent saved snapshot for a root — used to restore
   *  per-drive views when the user switches drives without triggering
   *  a fresh scan. Returns null if the root has no saved history. */
  getLatestSnapshotForRoot: (rootPath: string) => Promise<ScanSnapshot | null>;
  computeScanDiff: (baselineId: string, currentId: string) => Promise<ScanDiffResult | null>;
  getLatestDiff: (rootPath: string) => Promise<ScanDiffResult | null>;
  getFullDiffStatus: (baselineId: string, currentId: string, limit?: number) => Promise<FullDiffStatus>;
  /** Compute the full per-file diff from the persisted index files (not top-N). */
  computeFullScanDiff: (baselineId: string, currentId: string, limit?: number) => Promise<FullDiffResult | null>;
  /**
   * Returns the N largest files for the given root's latest scan, sourced from
   * the persisted full-file index (not just the in-memory top-N snapshot list).
   * Powers the dense WinDirStat-style treemap visualization.
   */
  getTreemapFiles: (rootPath: string, limit?: number) => Promise<ScanFileRecord[]>;
  /**
   * Returns direct-child folders (with recursive size + file count) and
   * top-N direct files for a given folder, sourced from the persisted
   * index. Powers the Folders tab drill-in — prior versions relied on
   * the snapshot's bounded top-N which showed "0B" for most subfolders
   * and ballooned renderer memory on deep trees.
   */
  getFolderChildren: (
    rootPath: string,
    parentPath: string,
  ) => Promise<{
    dirs: { path: string; size: number; fileCount: number }[];
    files: ScanFileRecord[];
  }>;

  // Theme
  applyTheme: (theme: "dark" | "light") => void;

  // Crash logs
  /** Read the tail of the crash log file (64 KB) for in-app display.
   *  Returns the absolute path too so users can share it with the
   *  developer. */
  getCrashLog: () => Promise<{ path: string; sizeBytes: number; text: string }>;
  /** Open the userData folder in the OS file browser, highlighting
   *  crash.log. */
  revealCrashLog: () => void;
  /** Forward a renderer-side error to the main process so it lands in
   *  the same crash.log alongside main-process exceptions. */
  reportRendererError: (payload: {
    message: string;
    stack?: string;
    source?: string;
  }) => void;

  // Auto-update
  checkForUpdates: () => Promise<void>;
  quitAndInstall: () => void;
  onUpdateStatus: (listener: (status: UpdateStatus) => void) => () => void;
  /** Load the persisted updater state (lastCheckedAt) so the UI shows a
   *  real timestamp across app restarts instead of "Never". */
  getUpdateState: () => Promise<UpdateState>;

  // Tray
  minimizeToTray: () => void;

  // Events
  onScanSnapshot: (listener: (snapshot: ScanSnapshot) => void) => () => void;
  onDiskDelta: (listener: (delta: DiskDelta) => void) => () => void;
  onNotification: (listener: (message: ToastMessage) => void) => () => void;
}

// ── Defaults ────────────────────────────────────────────────

export function defaultScanOptions(): ScanOptions {
  return {};
}

export function defaultSettings(): AppSettings {
  return {
    general: {
      minimizeToTray: true,
      startMinimized: false,
      launchOnStartup: true,
      theme: "dark",
      autoUpdate: true,
      colorBlindMode: false,
    },
    scanning: {
      defaultRootPath: "",
    },
    monitoring: {
      enabled: true, // on by default — DiskHound's value is continuous change tracking
      checkIntervalMinutes: 30,
      alertThresholdBytes: 1024 * 1024 * 1024, // 1 GB
      alertThresholdPercent: 5,
      fullScanIntervalMinutes: 60, // hourly scans so the Changes tab has fresh data
      requireIdle: false, // don't block scheduled scans on idle — scans are background-friendly
      idleMinutes: 10,
      excludedDrives: [],
    },
    notifications: {
      scanComplete: true,
      deltaAlerts: true,
    },
    cleanup: {
      autoDetectTempFiles: true,
      autoDetectCaches: true,
      autoDetectOldDownloads: true,
      oldFileThresholdDays: 90,
      safeDeleteToTrash: true,
    },
    recentScans: [],
    affinityRules: [],
  };
}

function clampInteger(value: unknown, minimum: number, maximum: number, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }

  const rounded = Math.round(value);
  return Math.min(maximum, Math.max(minimum, rounded));
}

/**
 * Resolve the scan interval in minutes, migrating users from the pre-v0.2.4
 * `fullScanIntervalHours` field if present. Clamped to [0, 30 days] minutes —
 * 0 disables scheduled full scans.
 */
function resolveFullScanIntervalMinutes(
  monitoring: Partial<MonitoringSettings> & { fullScanIntervalHours?: unknown },
  fallback: number,
): number {
  const MIN = 0;
  const MAX = 30 * 24 * 60;

  const minutes = monitoring.fullScanIntervalMinutes;
  if (typeof minutes === "number" && Number.isFinite(minutes)) {
    return Math.min(MAX, Math.max(MIN, Math.round(minutes)));
  }

  // Migrate legacy hours → minutes. Old files persisted `fullScanIntervalHours`;
  // multiply and drop the old key.
  const hours = monitoring.fullScanIntervalHours;
  if (typeof hours === "number" && Number.isFinite(hours)) {
    return Math.min(MAX, Math.max(MIN, Math.round(hours * 60)));
  }

  return fallback;
}

function isThemeValue(value: unknown): value is GeneralSettings["theme"] {
  return value === "dark" || value === "light" || value === "system";
}

export function normalizeAppSettings(input?: Partial<AppSettings> | null): AppSettings {
  const defaults = defaultSettings();
  const merged: AppSettings = {
    general: { ...defaults.general, ...(input?.general ?? {}) },
    scanning: { ...defaults.scanning, ...(input?.scanning ?? {}) },
    monitoring: { ...defaults.monitoring, ...(input?.monitoring ?? {}) },
    notifications: { ...defaults.notifications, ...(input?.notifications ?? {}) },
    cleanup: { ...defaults.cleanup, ...(input?.cleanup ?? {}) },
    recentScans: Array.isArray(input?.recentScans) ? input!.recentScans : defaults.recentScans,
    affinityRules: Array.isArray(input?.affinityRules)
      ? input!.affinityRules
          .map((r) => normalizeAffinityRule(r))
          .filter((r): r is AffinityRule => r !== null)
      : defaults.affinityRules,
  };

  const minimizeToTray = Boolean(merged.general.minimizeToTray);

  return {
    general: {
      minimizeToTray,
      startMinimized: minimizeToTray && Boolean(merged.general.startMinimized),
      launchOnStartup: Boolean(merged.general.launchOnStartup),
      theme: isThemeValue(merged.general.theme) ? merged.general.theme : defaults.general.theme,
      autoUpdate: merged.general.autoUpdate === undefined ? defaults.general.autoUpdate : Boolean(merged.general.autoUpdate),
      colorBlindMode: Boolean(merged.general.colorBlindMode),
    },
    scanning: {
      defaultRootPath:
        typeof merged.scanning.defaultRootPath === "string"
          ? merged.scanning.defaultRootPath
          : defaults.scanning.defaultRootPath,
    },
    monitoring: {
      enabled: Boolean(merged.monitoring.enabled),
      checkIntervalMinutes: clampInteger(
        merged.monitoring.checkIntervalMinutes,
        1,
        1440,
        defaults.monitoring.checkIntervalMinutes,
      ),
      alertThresholdBytes: clampInteger(
        merged.monitoring.alertThresholdBytes,
        0,
        50 * 1024 ** 4,
        defaults.monitoring.alertThresholdBytes,
      ),
      alertThresholdPercent: clampInteger(
        merged.monitoring.alertThresholdPercent,
        1,
        100,
        defaults.monitoring.alertThresholdPercent,
      ),
      fullScanIntervalMinutes: resolveFullScanIntervalMinutes(
        merged.monitoring,
        defaults.monitoring.fullScanIntervalMinutes,
      ),
      requireIdle: Boolean(merged.monitoring.requireIdle),
      idleMinutes: clampInteger(
        merged.monitoring.idleMinutes,
        1,
        240,
        defaults.monitoring.idleMinutes,
      ),
      excludedDrives: Array.isArray(merged.monitoring.excludedDrives)
        ? merged.monitoring.excludedDrives.filter((d): d is string => typeof d === "string")
        : [],
    },
    notifications: {
      scanComplete: Boolean(merged.notifications.scanComplete),
      deltaAlerts: Boolean(merged.notifications.deltaAlerts),
    },
    cleanup: {
      autoDetectTempFiles: Boolean(merged.cleanup.autoDetectTempFiles),
      autoDetectCaches: Boolean(merged.cleanup.autoDetectCaches),
      autoDetectOldDownloads: Boolean(merged.cleanup.autoDetectOldDownloads),
      oldFileThresholdDays: clampInteger(
        merged.cleanup.oldFileThresholdDays,
        1,
        3650,
        defaults.cleanup.oldFileThresholdDays,
      ),
      safeDeleteToTrash: Boolean(merged.cleanup.safeDeleteToTrash),
    },
    recentScans: (Array.isArray(merged.recentScans) ? merged.recentScans : [])
      .filter((scan): scan is RecentScan =>
        Boolean(scan) &&
        typeof scan.path === "string" &&
        scan.path.length > 0 &&
        typeof scan.scannedAt === "number" &&
        Number.isFinite(scan.scannedAt) &&
        typeof scan.filesFound === "number" &&
        Number.isFinite(scan.filesFound) &&
        typeof scan.bytesFound === "number" &&
        Number.isFinite(scan.bytesFound),
      )
      .slice(0, 10)
      .map((scan) => ({
        path: scan.path,
        scannedAt: Math.round(scan.scannedAt),
        filesFound: Math.max(0, Math.round(scan.filesFound)),
        bytesFound: Math.max(0, Math.round(scan.bytesFound)),
      })),
    affinityRules: merged.affinityRules,
  };
}

/**
 * Best-effort coercion from an unknown input (loaded JSON) to a
 * well-formed AffinityRule. Returns null for entries missing required
 * fields — the outer `.filter` drops those. Defensive rather than
 * throwing so a corrupt settings file doesn't brick the app.
 */
function normalizeAffinityRule(input: unknown): AffinityRule | null {
  if (!input || typeof input !== "object") return null;
  const r = input as Partial<AffinityRule>;
  if (typeof r.id !== "string" || r.id.length === 0) return null;
  if (typeof r.matchPattern !== "string" || r.matchPattern.length === 0) return null;
  const matchType = r.matchType === "exe_path" ? "exe_path" : "exe_name";
  const mask = typeof r.affinityMask === "number" && Number.isFinite(r.affinityMask)
    ? Math.max(1, Math.floor(r.affinityMask))
    : 0;
  if (mask === 0) return null; // zero mask would halt the process
  return {
    id: r.id,
    name: typeof r.name === "string" && r.name.length > 0 ? r.name : r.matchPattern,
    enabled: r.enabled !== false, // default to enabled
    matchType,
    matchPattern: r.matchPattern.toLowerCase(),
    affinityMask: mask,
    createdAt: typeof r.createdAt === "number" && Number.isFinite(r.createdAt)
      ? Math.round(r.createdAt)
      : Date.now(),
    lastAppliedAt: typeof r.lastAppliedAt === "number" && Number.isFinite(r.lastAppliedAt)
      ? Math.round(r.lastAppliedAt)
      : null,
    appliedCount: typeof r.appliedCount === "number" && Number.isFinite(r.appliedCount)
      ? Math.max(0, Math.round(r.appliedCount))
      : 0,
  };
}

export function createIdleScanSnapshot(): ScanSnapshot {
  return {
    status: "idle",
    engine: "js-worker",
    rootPath: null,
    scanOptions: defaultScanOptions(),
    startedAt: null,
    finishedAt: null,
    elapsedMs: 0,
    filesVisited: 0,
    directoriesVisited: 0,
    skippedEntries: 0,
    bytesSeen: 0,
    largestFiles: [],
    hottestDirectories: [],
    topExtensions: [],
    errorMessage: null,
    lastUpdatedAt: Date.now(),
    scanPhase: "starting",
    expectedTotalFiles: null,
  };
}
