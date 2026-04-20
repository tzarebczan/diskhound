import { contextBridge, ipcRenderer } from "electron";

import type {
  AppSettings,
  DiskDelta,
  DiskhoundNativeApi,
  DuplicateAnalysis,
  DuplicateScanProgress,
  ScanSnapshot,
  ToastMessage,
  UpdateStatus,
} from "./shared/contracts";

const SCAN_SNAPSHOT_CHANNEL = "diskhound:scan-snapshot";
const DISK_DELTA_CHANNEL = "diskhound:disk-delta";
const NOTIFICATION_CHANNEL = "diskhound:notification";
const DUPLICATE_PROGRESS_CHANNEL = "diskhound:duplicate-progress";
const DUPLICATE_RESULT_CHANNEL = "diskhound:duplicate-result";

const api: DiskhoundNativeApi = {
  // Scan
  pickRootPath: () => ipcRenderer.invoke("diskhound:pick-root"),
  getCurrentSnapshot: () => ipcRenderer.invoke("diskhound:get-current-snapshot"),
  startScan: (rootPath, options) => ipcRenderer.invoke("diskhound:start-scan", rootPath, options),
  cancelScan: () => ipcRenderer.invoke("diskhound:cancel-scan"),
  runScheduledScanNow: () => ipcRenderer.invoke("diskhound:run-scheduled-scan-now"),
  getFileIcon: (path, size) => ipcRenderer.invoke("diskhound:get-file-icon", path, size),

  // Process / memory viewer
  getMemorySnapshot: () => ipcRenderer.invoke("diskhound:get-memory-snapshot"),
  killProcess: (pid, signal) => ipcRenderer.invoke("diskhound:kill-process", pid, signal),

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
  getCachedMemorySnapshot: () => ipcRenderer.invoke("diskhound:get-cached-memory-snapshot"),
  getExecutableIcon: (path, size) => ipcRenderer.invoke("diskhound:get-executable-icon", path, size),

  // Cleanup analysis
  analyzeCleanup: (rootPath, files, dirs) =>
    ipcRenderer.invoke("diskhound:analyze-cleanup", rootPath, files, dirs),

  // Duplicate Detection
  startDuplicateScan: (rootPath, options) => ipcRenderer.invoke("diskhound:start-duplicate-scan", rootPath, options),
  cancelDuplicateScan: () => ipcRenderer.invoke("diskhound:cancel-duplicate-scan"),
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
  computeScanDiff: (baselineId, currentId) =>
    ipcRenderer.invoke("diskhound:compute-scan-diff", baselineId, currentId),
  getLatestDiff: (rootPath) => ipcRenderer.invoke("diskhound:get-latest-diff", rootPath),
  computeFullScanDiff: (baselineId, currentId, limit) =>
    ipcRenderer.invoke("diskhound:compute-full-scan-diff", baselineId, currentId, limit),
  getTreemapFiles: (rootPath, limit) =>
    ipcRenderer.invoke("diskhound:get-treemap-files", rootPath, limit),

  // Easy Move
  easyMove: (sourcePath, destinationDir) => ipcRenderer.invoke("diskhound:easy-move", sourcePath, destinationDir),
  easyMoveBack: (recordId) => ipcRenderer.invoke("diskhound:easy-move-back", recordId),
  getEasyMoves: () => ipcRenderer.invoke("diskhound:get-easy-moves"),
  pickMoveDestination: () => ipcRenderer.invoke("diskhound:pick-move-destination"),

  // Theme
  applyTheme: (theme) => ipcRenderer.send("diskhound:apply-theme", theme),

  // Auto-update
  checkForUpdates: () => ipcRenderer.invoke("diskhound:check-for-updates"),
  quitAndInstall: () => ipcRenderer.send("diskhound:quit-and-install"),
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
};

contextBridge.exposeInMainWorld("diskhound", api);
