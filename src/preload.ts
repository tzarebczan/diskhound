import { contextBridge, ipcRenderer } from "electron";

import type {
  AppSettings,
  DiskDelta,
  DiskhoundNativeApi,
  DiskhoundPlatform,
  DuplicateAnalysis,
  DuplicateScanProgress,
  EasyMoveProgress,
  ScanSnapshot,
  ToastMessage,
  UpdateStatus,
} from "./shared/contracts";

// Normalize node's rich NodeJS.Platform union down to the three
// platforms we actually ship binaries for. FreeBSD / AIX / SunOS are
// vanishingly rare in practice and behave like Linux for DiskHound's
// purposes (ps-based sampling, no MFT, no UAC), so bucket them there
// rather than forcing every UI consumer to handle "unknown OS".
const platform: DiskhoundPlatform =
  process.platform === "win32" ? "win32"
    : process.platform === "darwin" ? "darwin"
    : "linux";

const SCAN_SNAPSHOT_CHANNEL = "diskhound:scan-snapshot";
const DISK_DELTA_CHANNEL = "diskhound:disk-delta";
const EASY_MOVE_PROGRESS_CHANNEL = "diskhound:easy-move-progress";
const NOTIFICATION_CHANNEL = "diskhound:notification";
const DUPLICATE_PROGRESS_CHANNEL = "diskhound:duplicate-progress";
const DUPLICATE_RESULT_CHANNEL = "diskhound:duplicate-result";

const api: DiskhoundNativeApi = {
  platform,

  // Scan
  pickRootPath: () => ipcRenderer.invoke("diskhound:pick-root"),
  getCurrentSnapshot: () => ipcRenderer.invoke("diskhound:get-current-snapshot"),
  startScan: (rootPath, options) => ipcRenderer.invoke("diskhound:start-scan", rootPath, options),
  cancelScan: (rootPath) => ipcRenderer.invoke("diskhound:cancel-scan", rootPath),
  getActiveScanRoots: () => ipcRenderer.invoke("diskhound:get-active-scan-roots"),
  runScheduledScanNow: () => ipcRenderer.invoke("diskhound:run-scheduled-scan-now"),
  getFileIcon: (path, size) => ipcRenderer.invoke("diskhound:get-file-icon", path, size),

  // Process / memory viewer
  getMemorySnapshot: () => ipcRenderer.invoke("diskhound:get-memory-snapshot"),
  killProcess: (pid, signal) => ipcRenderer.invoke("diskhound:kill-process", pid, signal),
  getCpuAffinity: (pid) => ipcRenderer.invoke("diskhound:get-cpu-affinity", pid),
  setCpuAffinity: (pid, mask) => ipcRenderer.invoke("diskhound:set-cpu-affinity", pid, mask),
  getAffinityRules: () => ipcRenderer.invoke("diskhound:get-affinity-rules"),
  upsertAffinityRule: (rule) => ipcRenderer.invoke("diskhound:upsert-affinity-rule", rule),
  deleteAffinityRule: (id) => ipcRenderer.invoke("diskhound:delete-affinity-rule", id),

  // Path actions
  revealPath: (targetPath) => ipcRenderer.invoke("diskhound:reveal-path", targetPath),
  openPath: (targetPath) => ipcRenderer.invoke("diskhound:open-path", targetPath),
  trashPath: (targetPath) => ipcRenderer.invoke("diskhound:trash-path", targetPath),
  permanentlyDeletePath: (targetPath) =>
    ipcRenderer.invoke("diskhound:permanent-delete-path", targetPath),

  // Settings
  getSettings: () => ipcRenderer.invoke("diskhound:get-settings"),
  updateSettings: (settings) => ipcRenderer.invoke("diskhound:update-settings", settings),
  getRecentScans: () => ipcRenderer.invoke("diskhound:get-recent-scans"),

  // Monitoring
  getMonitoringSnapshot: () => ipcRenderer.invoke("diskhound:get-monitoring-snapshot"),
  getDiskSpace: () => ipcRenderer.invoke("diskhound:get-disk-space"),
  getDiskDeltaHistory: () => ipcRenderer.invoke("diskhound:get-disk-delta-history"),
  getScanScheduleInfo: () => ipcRenderer.invoke("diskhound:get-scan-schedule-info"),

  // Elevation / fast-scan admin
  getElevationStatus: () => ipcRenderer.invoke("diskhound:get-elevation-status"),
  relaunchAsAdmin: () => ipcRenderer.invoke("diskhound:relaunch-as-admin"),
  registerScheduledTask: () => ipcRenderer.invoke("diskhound:register-scheduled-task"),
  unregisterScheduledTask: () => ipcRenderer.invoke("diskhound:unregister-scheduled-task"),
  runScheduledTask: () => ipcRenderer.invoke("diskhound:run-scheduled-task"),
  getCachedMemorySnapshot: () => ipcRenderer.invoke("diskhound:get-cached-memory-snapshot"),
  getDiskIoSnapshot: () => ipcRenderer.invoke("diskhound:get-disk-io-snapshot"),
  getCachedDiskIoSnapshot: () => ipcRenderer.invoke("diskhound:get-cached-disk-io-snapshot"),
  getGpuSnapshot: () => ipcRenderer.invoke("diskhound:get-gpu-snapshot"),
  getCachedGpuSnapshot: () => ipcRenderer.invoke("diskhound:get-cached-gpu-snapshot"),
  openSystemWidget: () => ipcRenderer.invoke("diskhound:open-system-widget"),
  closeSystemWidget: () => ipcRenderer.invoke("diskhound:close-system-widget"),
  focusMainWindow: () => ipcRenderer.invoke("diskhound:focus-main-window"),
  setSystemWidgetPinned: (pinned) => ipcRenderer.invoke("diskhound:set-system-widget-pinned", pinned),
  getExecutableIcon: (path, size) => ipcRenderer.invoke("diskhound:get-executable-icon", path, size),

  // Cleanup analysis
  analyzeCleanup: (rootPath, files, dirs) =>
    ipcRenderer.invoke("diskhound:analyze-cleanup", rootPath, files, dirs),

  // Duplicate Detection
  startDuplicateScan: (rootPath, options) => ipcRenderer.invoke("diskhound:start-duplicate-scan", rootPath, options),
  cancelDuplicateScan: (rootPath) => ipcRenderer.invoke("diskhound:cancel-duplicate-scan", rootPath),
  getActiveDuplicateScanRoots: () => ipcRenderer.invoke("diskhound:get-active-duplicate-scan-roots"),
  onDuplicateProgress: (listener) => {
    const wrapped = (_event: Electron.IpcRendererEvent, progress: DuplicateScanProgress) => {
      listener(progress);
    };
    ipcRenderer.on(DUPLICATE_PROGRESS_CHANNEL, wrapped);
    return () => { ipcRenderer.removeListener(DUPLICATE_PROGRESS_CHANNEL, wrapped); };
  },
  onDuplicateResult: (listener) => {
    const wrapped = (_event: Electron.IpcRendererEvent, result: DuplicateAnalysis) => {
      listener(result);
    };
    ipcRenderer.on(DUPLICATE_RESULT_CHANNEL, wrapped);
    return () => { ipcRenderer.removeListener(DUPLICATE_RESULT_CHANNEL, wrapped); };
  },

  // Scan History & Diff
  getScanHistory: (rootPath) => ipcRenderer.invoke("diskhound:get-scan-history", rootPath),
  getLatestSnapshotForRoot: (rootPath) => ipcRenderer.invoke("diskhound:get-latest-snapshot-for-root", rootPath),
  computeScanDiff: (baselineId, currentId) =>
    ipcRenderer.invoke("diskhound:compute-scan-diff", baselineId, currentId),
  getLatestDiff: (rootPath) => ipcRenderer.invoke("diskhound:get-latest-diff", rootPath),
  getFullDiffStatus: (baselineId, currentId, limit) =>
    ipcRenderer.invoke("diskhound:get-full-diff-status", baselineId, currentId, limit),
  computeFullScanDiff: (baselineId, currentId, limit) =>
    ipcRenderer.invoke("diskhound:compute-full-scan-diff", baselineId, currentId, limit),
  getTreemapFiles: (rootPath, limit) =>
    ipcRenderer.invoke("diskhound:get-treemap-files", rootPath, limit),
  getFolderChildren: (rootPath, parentPath) =>
    ipcRenderer.invoke("diskhound:get-folder-children", rootPath, parentPath),

  // Easy Move
  easyMove: (sourcePath, destinationDir) => ipcRenderer.invoke("diskhound:easy-move", sourcePath, destinationDir),
  easyMoveElevated: (sourcePath, destinationDir) => ipcRenderer.invoke("diskhound:easy-move-elevated", sourcePath, destinationDir),
  easyMoveBack: (recordId) => ipcRenderer.invoke("diskhound:easy-move-back", recordId),
  getEasyMoves: () => ipcRenderer.invoke("diskhound:get-easy-moves"),
  verifyEasyMoves: () => ipcRenderer.invoke("diskhound:verify-easy-moves"),
  pickMoveDestination: () => ipcRenderer.invoke("diskhound:pick-move-destination"),

  // Theme
  applyTheme: (theme) => ipcRenderer.send("diskhound:apply-theme", theme),

  // Crash logs
  getCrashLog: () => ipcRenderer.invoke("diskhound:get-crash-log"),
  revealCrashLog: () => ipcRenderer.send("diskhound:reveal-crash-log"),
  reportRendererError: (payload) =>
    ipcRenderer.send("diskhound:report-renderer-error", payload),

  // Auto-update
  checkForUpdates: () => ipcRenderer.invoke("diskhound:check-for-updates"),
  quitAndInstall: () => ipcRenderer.send("diskhound:quit-and-install"),
  getUpdateState: () => ipcRenderer.invoke("diskhound:get-update-state"),
  onUpdateStatus: (listener) => {
    const wrapped = (_event: Electron.IpcRendererEvent, status: UpdateStatus) => listener(status);
    ipcRenderer.on("diskhound:update-status", wrapped);
    return () => { ipcRenderer.removeListener("diskhound:update-status", wrapped); };
  },

  // Tray
  minimizeToTray: () => ipcRenderer.send("diskhound:minimize-to-tray"),

  // Events
  onScanSnapshot: (listener) => {
    const wrapped = (_event: Electron.IpcRendererEvent, snapshot: ScanSnapshot) => {
      listener(snapshot);
    };
    ipcRenderer.on(SCAN_SNAPSHOT_CHANNEL, wrapped);
    return () => { ipcRenderer.removeListener(SCAN_SNAPSHOT_CHANNEL, wrapped); };
  },

  onDiskDelta: (listener) => {
    const wrapped = (_event: Electron.IpcRendererEvent, delta: DiskDelta) => {
      listener(delta);
    };
    ipcRenderer.on(DISK_DELTA_CHANNEL, wrapped);
    return () => { ipcRenderer.removeListener(DISK_DELTA_CHANNEL, wrapped); };
  },

  onNotification: (listener) => {
    const wrapped = (_event: Electron.IpcRendererEvent, message: ToastMessage) => {
      listener(message);
    };
    ipcRenderer.on(NOTIFICATION_CHANNEL, wrapped);
    return () => { ipcRenderer.removeListener(NOTIFICATION_CHANNEL, wrapped); };
  },
  onEasyMoveProgress: (listener) => {
    const wrapped = (_event: Electron.IpcRendererEvent, progress: EasyMoveProgress) => {
      listener(progress);
    };
    ipcRenderer.on(EASY_MOVE_PROGRESS_CHANNEL, wrapped);
    return () => { ipcRenderer.removeListener(EASY_MOVE_PROGRESS_CHANNEL, wrapped); };
  },
};

contextBridge.exposeInMainWorld("diskhound", api);
