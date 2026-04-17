// ── Scan Types ──────────────────────────────────────────────

export type ScanStatus = "idle" | "running" | "done" | "cancelled" | "error";
export type ScanEngine = "js-worker" | "native-sidecar";

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
}

export interface PathActionResult {
  ok: boolean;
  message: string;
}

export interface ScanStartInput {
  rootPath: string;
  options: ScanOptions;
  limits?: {
    topFileLimit: number;
    topDirectoryLimit: number;
  };
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
}

export interface ScanningSettings {
  defaultRootPath: string;
  topFileLimit: number;
  topDirectoryLimit: number;
}

export interface MonitoringSettings {
  enabled: boolean;
  checkIntervalMinutes: number;
  alertThresholdBytes: number; // alert when free space drops by this much
  alertThresholdPercent: number; // or by this percentage
  fullScanIntervalHours: number; // periodic full re-scan
  requireIdle: boolean; // only scan when system is idle
  idleMinutes: number; // how long idle before scanning
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
  status: DuplicateScanStatus;
  filesWalked: number;
  candidateGroups: number;
  filesHashed: number;
  groupsConfirmed: number;
  elapsedMs: number;
  errorMessage: string | null;
}

// ── View Types ──────────────────────────────────────────────

export type AppView = "overview" | "files" | "folders" | "duplicates" | "easyMove" | "changes" | "settings";

// ── IPC API ─────────────────────────────────────────────────

export interface DiskhoundNativeApi {
  // Scan
  pickRootPath: () => Promise<string | null>;
  getCurrentSnapshot: () => Promise<ScanSnapshot>;
  startScan: (rootPath: string, options: ScanOptions) => Promise<ScanSnapshot>;
  cancelScan: () => Promise<ScanSnapshot>;

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

  // Cleanup analysis
  analyzeCleanup: (rootPath: string, files: ScanFileRecord[], dirs: DirectoryHotspot[]) => Promise<CleanupAnalysis>;

  // Easy Move
  easyMove: (sourcePath: string, destinationDir: string) => Promise<EasyMoveResult>;
  easyMoveBack: (recordId: string) => Promise<PathActionResult>;
  getEasyMoves: () => Promise<EasyMoveRecord[]>;
  pickMoveDestination: () => Promise<string | null>;

  // Duplicate Detection
  startDuplicateScan: (rootPath: string) => Promise<void>;
  cancelDuplicateScan: () => Promise<void>;
  onDuplicateProgress: (listener: (progress: DuplicateScanProgress) => void) => () => void;
  onDuplicateResult: (listener: (result: DuplicateAnalysis) => void) => () => void;

  // Scan History & Diff
  getScanHistory: (rootPath: string) => Promise<ScanHistoryEntry[]>;
  computeScanDiff: (baselineId: string, currentId: string) => Promise<ScanDiffResult | null>;
  getLatestDiff: (rootPath: string) => Promise<ScanDiffResult | null>;

  // Theme
  applyTheme: (theme: "dark" | "light") => void;

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
      minimizeToTray: false,
      startMinimized: false,
      launchOnStartup: false,
      theme: "dark",
    },
    scanning: {
      defaultRootPath: "",
      topFileLimit: 100,
      topDirectoryLimit: 500,
    },
    monitoring: {
      enabled: false,
      checkIntervalMinutes: 30,
      alertThresholdBytes: 1024 * 1024 * 1024, // 1 GB
      alertThresholdPercent: 5,
      fullScanIntervalHours: 24,
      requireIdle: true,
      idleMinutes: 10,
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
  };
}

function clampInteger(value: unknown, minimum: number, maximum: number, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }

  const rounded = Math.round(value);
  return Math.min(maximum, Math.max(minimum, rounded));
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
  };

  const minimizeToTray = Boolean(merged.general.minimizeToTray);

  return {
    general: {
      minimizeToTray,
      startMinimized: minimizeToTray && Boolean(merged.general.startMinimized),
      launchOnStartup: Boolean(merged.general.launchOnStartup),
      theme: isThemeValue(merged.general.theme) ? merged.general.theme : defaults.general.theme,
    },
    scanning: {
      defaultRootPath:
        typeof merged.scanning.defaultRootPath === "string"
          ? merged.scanning.defaultRootPath
          : defaults.scanning.defaultRootPath,
      topFileLimit: clampInteger(
        merged.scanning.topFileLimit,
        25,
        5000,
        defaults.scanning.topFileLimit,
      ),
      topDirectoryLimit: clampInteger(
        merged.scanning.topDirectoryLimit,
        25,
        10000,
        defaults.scanning.topDirectoryLimit,
      ),
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
      fullScanIntervalHours: clampInteger(
        merged.monitoring.fullScanIntervalHours,
        0,
        24 * 30,
        defaults.monitoring.fullScanIntervalHours,
      ),
      requireIdle: Boolean(merged.monitoring.requireIdle),
      idleMinutes: clampInteger(
        merged.monitoring.idleMinutes,
        1,
        240,
        defaults.monitoring.idleMinutes,
      ),
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
  };
}
