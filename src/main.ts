import * as FS from "node:fs/promises";
import * as Path from "node:path";
import { Worker } from "node:worker_threads";

import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  nativeImage,
  Notification,
  powerMonitor,
  shell,
  Tray,
} from "electron";
import {
  createIdleScanSnapshot,
  defaultScanOptions,
  type AppSettings,
  type DirectoryHotspot,
  type PathActionResult,
  type ScanEngine,
  type ScanFileRecord,
  type ScanOptions,
  type ScanSnapshot,
  type ToastMessage,
  type WorkerToMainMessage,
} from "./shared/contracts";
import {
  checkDiskDeltas,
  getDiskSpace,
  getLastFullScanAt,
  initDiskMonitor,
  markFullScan,
} from "./shared/diskMonitor";
import { createScanSnapshotStore } from "./shared/scanStore";
import { createSettingsStore, type SettingsStore } from "./shared/settingsStore";
import { easyMove, easyMoveBack, getEasyMoves, initEasyMoveStore } from "./shared/easyMoveStore";
import {
  getScanHistory,
  getLatestPair,
  initScanHistory,
  loadHistoricalSnapshot,
  saveScanToHistory,
} from "./shared/scanHistory";
import { computeDiff } from "./shared/scanDiff";
import { runDuplicateScan, type DuplicateScanHandle } from "./shared/duplicates";
import { analyzeForCleanup } from "./shared/suggestions";
import { createNativeScannerSession, type NativeScannerSession } from "./nativeScanner";

const SCAN_SNAPSHOT_CHANNEL = "diskhound:scan-snapshot";
const DISK_DELTA_CHANNEL = "diskhound:disk-delta";
const NOTIFICATION_CHANNEL = "diskhound:notification";
const DUPLICATE_PROGRESS_CHANNEL = "diskhound:duplicate-progress";
const DUPLICATE_RESULT_CHANNEL = "diskhound:duplicate-result";

const isDevelopment = Boolean(process.env.VITE_DEV_SERVER_URL);
const rendererEntryUrl = process.env.VITE_DEV_SERVER_URL;
const projectRoot = Path.join(__dirname, "..");
const rendererEntryFile = Path.join(projectRoot, "dist-renderer", "index.html");
const scanWorkerEntry = Path.join(__dirname, "scan", "scanWorker.cjs");

type WorkerScanSession = {
  kind: "worker";
  active: boolean;
  stop: () => Promise<void>;
};

type ActiveScanSession = (WorkerScanSession | NativeScannerSession) & {
  active: boolean;
};

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let activeScan: ActiveScanSession | null = null;
let activeDuplicateScan: DuplicateScanHandle | null = null;
let monitoringInterval: ReturnType<typeof setInterval> | null = null;
let settingsStore: SettingsStore | null = null;
// Track whether the user explicitly quit (vs. close-to-tray)
let isQuitting = false;

app.commandLine.appendSwitch("enable-gpu-rasterization");
app.commandLine.appendSwitch("enable-oop-rasterization");
app.commandLine.appendSwitch("enable-zero-copy");

let toastCounter = 0;
const sendToast = (level: ToastMessage["level"], title: string, body?: string) => {
  const toast: ToastMessage = {
    id: `toast-${++toastCounter}`,
    level,
    title,
    body,
    dismissAfterMs: 5_000,
  };
  mainWindow?.webContents.send(NOTIFICATION_CHANNEL, toast);
};

function createTrayIconImage(): Electron.NativeImage {
  // Use the app icon (build/icon.png), resized to tray dimensions
  const iconPaths = [
    Path.join(projectRoot, "build", "icon.png"),
    Path.join(process.resourcesPath ?? projectRoot, "icon.png"),
  ];

  for (const iconPath of iconPaths) {
    try {
      if (require("fs").existsSync(iconPath)) {
        const icon = nativeImage.createFromPath(iconPath);
        return icon.resize({ width: 16, height: 16 });
      }
    } catch { /* continue */ }
  }

  // Fallback: simple amber square if icon file not found
  const size = 16;
  const buf = Buffer.alloc(size * size * 4);
  for (let i = 0; i < size * size; i++) {
    buf[i * 4] = 11; buf[i * 4 + 1] = 158; buf[i * 4 + 2] = 245; buf[i * 4 + 3] = 255;
  }
  return nativeImage.createFromBitmap(buf, { width: size, height: size });
}

void app.whenReady().then(async () => {
  if (process.platform === "win32") {
    app.setAppUserModelId("com.diskhound.app");
  }

  const scanStore = await createScanSnapshotStore(app.getPath("userData"));
  settingsStore = await createSettingsStore();

  // Initialize disk monitor with persistent baseline storage
  await initDiskMonitor(app.getPath("userData"));

  // Initialize easy-move store
  initEasyMoveStore(app.getPath("userData"));

  // Initialize scan history
  initScanHistory(app.getPath("userData"));

  // ── Scan helpers ──────────────────────────────────────────

  const broadcastSnapshot = async (nextSnapshot: ScanSnapshot) => {
    await scanStore.set(nextSnapshot);
    mainWindow?.webContents.send(SCAN_SNAPSHOT_CHANNEL, nextSnapshot);
  };

  const buildRunningSnapshot = (
    rootPath: string,
    scanOptions: ScanOptions,
    engine: ScanEngine,
  ): ScanSnapshot => ({
    ...createIdleScanSnapshot(),
    status: "running",
    engine,
    rootPath,
    scanOptions,
    startedAt: Date.now(),
    finishedAt: null,
    lastUpdatedAt: Date.now(),
  });

  const buildErrorSnapshot = async (
    startingSnapshot: ScanSnapshot,
    errorMessage: string,
  ): Promise<ScanSnapshot> => ({
    ...(await scanStore.get()),
    status: "error",
    engine: startingSnapshot.engine,
    rootPath: startingSnapshot.rootPath,
    scanOptions: startingSnapshot.scanOptions,
    finishedAt: Date.now(),
    elapsedMs:
      startingSnapshot.startedAt === null ? 0 : Date.now() - startingSnapshot.startedAt,
    errorMessage,
    lastUpdatedAt: Date.now(),
  });

  const handleRuntimeMessage = async (
    session: ActiveScanSession,
    message: WorkerToMainMessage,
  ) => {
    if (!session.active) return;

    if (message.type === "progress" || message.type === "done") {
      if (message.type === "done") {
        // Persist history before notifying the renderer so immediate diff
        // lookups can see the just-finished scan.
        await saveScanToHistory(message.snapshot);
      }

      await broadcastSnapshot(message.snapshot);
      if (message.type === "done") {
        session.active = false;
        if (activeScan === session) activeScan = null;
        markFullScan();

        const settings = settingsStore?.get();

        // Record in recent scans
        if (settings && message.snapshot.rootPath) {
          const MAX_RECENT = 10;
          const recent = settings.recentScans.filter(
            (r) => r.path !== message.snapshot.rootPath,
          );
          recent.unshift({
            path: message.snapshot.rootPath,
            scannedAt: Date.now(),
            filesFound: message.snapshot.filesVisited,
            bytesFound: message.snapshot.bytesSeen,
          });
          if (recent.length > MAX_RECENT) recent.length = MAX_RECENT;
          void settingsStore!.set({ ...settings, recentScans: recent });
        }

        if (settings?.notifications.scanComplete) {
          sendToast("success", "Scan complete",
            `Found ${message.snapshot.filesVisited.toLocaleString()} files, ${formatBytesShort(message.snapshot.bytesSeen)} total.`);

          if (Notification.isSupported()) {
            new Notification({
              title: "DiskHound - Scan Complete",
              body: `${message.snapshot.filesVisited.toLocaleString()} files scanned.`,
            }).show();
          }
        }
      }
    }
  };

  const handleRuntimeFailure = async (
    session: ActiveScanSession,
    startingSnapshot: ScanSnapshot,
    error: unknown,
  ) => {
    if (!session.active) return;
    session.active = false;
    if (activeScan === session) activeScan = null;
    await broadcastSnapshot(
      await buildErrorSnapshot(
        startingSnapshot,
        error instanceof Error ? error.message : String(error),
      ),
    );
  };

  const createWorkerSession = (
    rootPath: string,
    scanOptions: ScanOptions,
  ): { session: WorkerScanSession; startingSnapshot: ScanSnapshot } => {
    const worker = new Worker(scanWorkerEntry);
    const startingSnapshot = buildRunningSnapshot(rootPath, scanOptions, "js-worker");

    const session: WorkerScanSession = {
      kind: "worker",
      active: true,
      stop: async () => {
        // Ask the worker to stop gracefully first
        worker.postMessage({ type: "cancel" });
        // Give it 500ms to emit a final snapshot, then force-terminate
        await new Promise<void>((resolve) => {
          const timeout = setTimeout(async () => {
            await worker.terminate();
            resolve();
          }, 500);
          worker.once("exit", () => { clearTimeout(timeout); resolve(); });
        });
      },
    };

    worker.on("message", (message: WorkerToMainMessage) => {
      void handleRuntimeMessage(session, message);
    });

    worker.on("error", (error) => {
      void handleRuntimeFailure(session, startingSnapshot, error);
    });

    // Pass configurable limits from settings
    const settings = settingsStore?.get();
    worker.postMessage({
      type: "start",
      input: {
        rootPath,
        options: scanOptions,
        limits: settings ? {
          topFileLimit: settings.scanning.topFileLimit,
          topDirectoryLimit: settings.scanning.topDirectoryLimit,
        } : undefined,
      },
    });

    return { session, startingSnapshot };
  };

  const createPreferredScanSession = (
    rootPath: string,
    scanOptions: ScanOptions,
  ): { session: ActiveScanSession; startingSnapshot: ScanSnapshot } => {
    const nativeStartingSnapshot = buildRunningSnapshot(rootPath, scanOptions, "native-sidecar");

    // Pass configurable limits from settings to the native scanner
    const currentSettings = settingsStore?.get();
    const scanLimits = currentSettings ? {
      topFileLimit: currentSettings.scanning.topFileLimit,
      topDirectoryLimit: currentSettings.scanning.topDirectoryLimit,
    } : undefined;

    // Buffer for messages that arrive before the session is fully wired
    const earlyMessages: WorkerToMainMessage[] = [];
    let earlyErrors: Error[] = [];
    let sessionRef: ActiveScanSession | null = null;

    const nativeResult = createNativeScannerSession(
      projectRoot,
      { rootPath, options: scanOptions, limits: scanLimits },
      {
        onMessage: (message) => {
          if (!sessionRef) {
            // Session not yet wired — buffer
            earlyMessages.push(message);
            return;
          }
          void handleRuntimeMessage(sessionRef, message);
        },
        onError: (error) => {
          if (!sessionRef) {
            earlyErrors.push(error);
            return;
          }
          void handleRuntimeFailure(sessionRef, nativeStartingSnapshot, error);
        },
      },
    );

    if (nativeResult) {
      // Wire up the session with active=true BEFORE flushing buffered messages
      sessionRef = Object.assign(nativeResult, { active: true }) as ActiveScanSession;

      // Flush any messages that arrived during construction
      for (const msg of earlyMessages) {
        void handleRuntimeMessage(sessionRef, msg);
      }
      for (const err of earlyErrors) {
        void handleRuntimeFailure(sessionRef, nativeStartingSnapshot, err);
      }

      return { session: sessionRef, startingSnapshot: nativeStartingSnapshot };
    }

    return createWorkerSession(rootPath, scanOptions);
  };

  const cancelActiveScan = async () => {
    const session = activeScan;
    activeScan = null;

    if (!session) return scanStore.get();

    session.active = false;
    await session.stop();
    const cancelledSnapshot = await scanStore.update((current) => ({
      ...current,
      status: current.status === "running" ? "cancelled" : current.status,
      finishedAt: Date.now(),
      elapsedMs:
        current.startedAt === null ? current.elapsedMs : Date.now() - current.startedAt,
      lastUpdatedAt: Date.now(),
    }));
    mainWindow?.webContents.send(SCAN_SNAPSHOT_CHANNEL, cancelledSnapshot);
    return cancelledSnapshot;
  };

  const startScan = async (rootPathInput: string, scanOptions: ScanOptions) => {
    const resolvedScanOptions = { ...defaultScanOptions(), ...scanOptions };
    const rootPath = Path.resolve(rootPathInput);
    await cancelActiveScan();

    const { session, startingSnapshot } = createPreferredScanSession(rootPath, resolvedScanOptions);
    activeScan = session;
    await broadcastSnapshot(startingSnapshot);
    return startingSnapshot;
  };

  const pathAction = async (message: string, task: () => Promise<void>): Promise<PathActionResult> => {
    try {
      await task();
      return { ok: true, message };
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : String(error) };
    }
  };

  // ── IPC: Scan ─────────────────────────────────────────────

  ipcMain.handle("diskhound:pick-root", async () => {
    if (!mainWindow) return null;
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ["openDirectory"],
      title: "Choose a folder to scan",
      buttonLabel: "Scan folder",
    });
    return result.canceled ? null : result.filePaths[0] ?? null;
  });

  ipcMain.handle("diskhound:get-current-snapshot", () => scanStore.get());
  ipcMain.handle("diskhound:start-scan", (_event, rootPath: string, scanOptions: ScanOptions) =>
    startScan(rootPath, scanOptions),
  );
  ipcMain.handle("diskhound:cancel-scan", () => cancelActiveScan());

  // ── IPC: Path Actions ─────────────────────────────────────

  ipcMain.handle("diskhound:reveal-path", (_event, targetPath: string) =>
    pathAction("Revealed in file manager.", async () => {
      shell.showItemInFolder(targetPath);
    }),
  );
  ipcMain.handle("diskhound:open-path", (_event, targetPath: string) =>
    pathAction("Opened target path.", async () => {
      const result = await shell.openPath(targetPath);
      if (result) throw new Error(result);
    }),
  );
  ipcMain.handle("diskhound:trash-path", (_event, targetPath: string) =>
    pathAction("Moved to trash.", async () => {
      await shell.trashItem(targetPath);
    }),
  );
  ipcMain.handle("diskhound:permanent-delete-path", (_event, targetPath: string) =>
    pathAction("Permanently deleted.", async () => {
      const stat = await FS.lstat(targetPath);
      await FS.rm(targetPath, {
        recursive: stat.isDirectory(),
        force: false,
        maxRetries: 2,
      });
    }),
  );

  // ── IPC: Settings ─────────────────────────────────────────

  ipcMain.handle("diskhound:get-settings", () => settingsStore!.get());
  ipcMain.handle("diskhound:update-settings", async (_event, settings: AppSettings) => {
    const previousSettings = settingsStore!.get();
    await settingsStore!.set(settings);

    // Wire launchOnStartup to OS login items
    if (settings.general.launchOnStartup !== previousSettings.general.launchOnStartup) {
      applyLoginItemSettings(settings.general.launchOnStartup);
    }

    // Recreate tray or destroy it based on minimizeToTray toggle
    if (settings.general.minimizeToTray && !tray) {
      createTray();
    } else if (!settings.general.minimizeToTray && tray) {
      tray.destroy();
      tray = null;
    }

    restartMonitoring(settings);
  });

  ipcMain.handle("diskhound:get-recent-scans", () => settingsStore!.get().recentScans ?? []);

  // ── IPC: Easy Move ───────────────────────────────────────

  ipcMain.handle("diskhound:easy-move", async (_event, sourcePath: string, destinationDir: string) => {
    return easyMove(sourcePath, destinationDir);
  });

  ipcMain.handle("diskhound:easy-move-back", async (_event, recordId: string) => {
    return easyMoveBack(recordId);
  });

  ipcMain.handle("diskhound:get-easy-moves", () => getEasyMoves());

  ipcMain.handle("diskhound:pick-move-destination", async () => {
    if (!mainWindow) return null;
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ["openDirectory"],
      title: "Choose destination folder",
    });
    return result.canceled ? null : result.filePaths[0] ?? null;
  });

  // ── IPC: Scan History & Diff ──────────────────────────────

  ipcMain.handle("diskhound:get-scan-history", (_event, rootPath: string) => {
    return getScanHistory(rootPath);
  });

  ipcMain.handle("diskhound:compute-scan-diff", async (_event, baselineId: string, currentId: string) => {
    const [baseline, current] = await Promise.all([
      loadHistoricalSnapshot(baselineId),
      loadHistoricalSnapshot(currentId),
    ]);
    if (!baseline || !current) return null;
    return computeDiff(baseline, current, baselineId, currentId);
  });

  ipcMain.handle("diskhound:get-latest-diff", async (_event, rootPath: string) => {
    const pair = getLatestPair(rootPath);
    if (!pair) return null;
    const [baseline, current] = await Promise.all([
      loadHistoricalSnapshot(pair.baseline.id),
      loadHistoricalSnapshot(pair.current.id),
    ]);
    if (!baseline || !current) return null;
    return computeDiff(baseline, current, pair.baseline.id, pair.current.id);
  });

  // ── IPC: Monitoring ───────────────────────────────────────

  ipcMain.handle("diskhound:get-monitoring-snapshot", () => checkDiskDeltas());
  ipcMain.handle("diskhound:get-disk-space", () => getDiskSpace());

  // ── IPC: Cleanup Analysis ─────────────────────────────────

  ipcMain.handle("diskhound:analyze-cleanup", (_event, rootPath: string, files: ScanFileRecord[], dirs: DirectoryHotspot[]) => {
    const settings = settingsStore!.get();
    return analyzeForCleanup(rootPath, files, dirs, settings.cleanup);
  });

  // ── IPC: Duplicate Detection ────────────────────────────

  ipcMain.handle("diskhound:start-duplicate-scan", (_event, rootPath: string) => {
    if (activeDuplicateScan) {
      activeDuplicateScan.cancel();
      activeDuplicateScan = null;
    }

    activeDuplicateScan = runDuplicateScan(Path.resolve(rootPath), {
      onProgress: (progress) => {
        mainWindow?.webContents.send(DUPLICATE_PROGRESS_CHANNEL, progress);
      },
      onResult: (result) => {
        mainWindow?.webContents.send(DUPLICATE_RESULT_CHANNEL, result);
        activeDuplicateScan = null;
        sendToast("success", "Duplicate scan complete",
          `Found ${result.totalGroups} group${result.totalGroups === 1 ? "" : "s"}, ${formatBytesShort(result.totalWastedBytes)} reclaimable.`);
      },
      onError: (error) => {
        mainWindow?.webContents.send(DUPLICATE_PROGRESS_CHANNEL, {
          status: "error",
          filesWalked: 0,
          candidateGroups: 0,
          filesHashed: 0,
          groupsConfirmed: 0,
          elapsedMs: 0,
          errorMessage: error.message,
        });
        activeDuplicateScan = null;
      },
    });
  });

  ipcMain.handle("diskhound:cancel-duplicate-scan", () => {
    if (activeDuplicateScan) {
      activeDuplicateScan.cancel();
      activeDuplicateScan = null;
    }
  });

  // ── IPC: Tray ─────────────────────────────────────────────

  ipcMain.on("diskhound:apply-theme", (_event, theme: "dark" | "light") => {
    if (!mainWindow) return;
    const isDark = theme === "dark";
    mainWindow.setBackgroundColor(isDark ? "#0a0a0f" : "#f8fafc");
    mainWindow.setTitleBarOverlay({
      color: isDark ? "#0a0a0f" : "#f8fafc",
      symbolColor: isDark ? "#94a3b8" : "#475569",
    });
  });

  ipcMain.on("diskhound:minimize-to-tray", () => {
    mainWindow?.hide();
  });

  // ── Login Item Settings ───────────────────────────────────

  function applyLoginItemSettings(enabled: boolean) {
    try {
      app.setLoginItemSettings({
        openAtLogin: enabled,
        args: enabled ? ["--start-minimized"] : [],
      });
    } catch {
      // Not supported on all platforms
    }
  }

  // ── Monitoring Loop ───────────────────────────────────────

  const restartMonitoring = (settings: AppSettings) => {
    if (monitoringInterval) {
      clearInterval(monitoringInterval);
      monitoringInterval = null;
    }

    if (!settings.monitoring.enabled) return;

    const checkMs = settings.monitoring.checkIntervalMinutes * 60 * 1000;

    monitoringInterval = setInterval(async () => {
      // Gate on system idle if configured
      if (settings.monitoring.requireIdle) {
        const idleSeconds = powerMonitor.getSystemIdleTime();
        const requiredIdleSeconds = settings.monitoring.idleMinutes * 60;
        if (idleSeconds < requiredIdleSeconds) {
          return; // System not idle long enough, skip this check
        }
      }

      // Check disk deltas
      const snapshot = await checkDiskDeltas();

      // Only alert on free-space DECREASES (negative deltaBytes)
      for (const delta of snapshot.deltas) {
        if (delta.deltaBytes >= 0) continue; // Space increased — not actionable

        const decrease = Math.abs(delta.deltaBytes);
        const decreasePct = Math.abs(delta.deltaPercent);
        const shouldAlert =
          decrease >= settings.monitoring.alertThresholdBytes ||
          decreasePct >= settings.monitoring.alertThresholdPercent;

        if (shouldAlert && settings.notifications.deltaAlerts) {
          sendToast("warning", "Free space decreased",
            `${delta.drive}: lost ${formatBytesShort(decrease)} since last check.`);

          mainWindow?.webContents.send(DISK_DELTA_CHANNEL, delta);

          if (Notification.isSupported() && !mainWindow?.isVisible()) {
            new Notification({
              title: "DiskHound - Free Space Decreased",
              body: `${delta.drive}: lost ${formatBytesShort(decrease)}.`,
            }).show();
          }
        }
      }

      // Scheduled full rescan if interval has elapsed
      if (settings.monitoring.fullScanIntervalHours > 0) {
        const lastScan = getLastFullScanAt();
        const intervalMs = settings.monitoring.fullScanIntervalHours * 3_600_000;
        const now = Date.now();

        if (lastScan === null || now - lastScan >= intervalMs) {
          const defaultPath = settings.scanning.defaultRootPath;
          if (defaultPath && !activeScan) {
            void startScan(defaultPath, defaultScanOptions());
            sendToast("info", "Scheduled rescan started",
              `Rescanning ${defaultPath} after ${settings.monitoring.fullScanIntervalHours}h interval.`);
          }
        }
      }
    }, checkMs);
  };

  // ── System Tray ───────────────────────────────────────────

  const createTray = () => {
    const icon = createTrayIconImage();
    tray = new Tray(icon);
    tray.setToolTip("DiskHound");

    const contextMenu = Menu.buildFromTemplate([
      {
        label: "Show DiskHound",
        click: () => {
          mainWindow?.show();
          mainWindow?.focus();
        },
      },
      { type: "separator" },
      {
        label: "Quick Scan",
        click: () => {
          const settings = settingsStore?.get();
          if (settings?.scanning.defaultRootPath) {
            void startScan(settings.scanning.defaultRootPath, defaultScanOptions());
          }
          mainWindow?.show();
          mainWindow?.focus();
        },
      },
      { type: "separator" },
      {
        label: "Quit",
        click: () => {
          isQuitting = true;
          app.quit();
        },
      },
    ]);

    tray.setContextMenu(contextMenu);
    tray.on("double-click", () => {
      mainWindow?.show();
      mainWindow?.focus();
    });
  };

  // ── Window ────────────────────────────────────────────────

  const createWindow = async () => {
    mainWindow = new BrowserWindow({
      width: 1560,
      height: 980,
      minWidth: 960,
      minHeight: 640,
      backgroundColor: "#0a0a0f",
      title: isDevelopment ? "DiskHound (Dev)" : "DiskHound",
      titleBarStyle: "hidden",
      titleBarOverlay: {
        color: "#0a0a0f",
        symbolColor: "#94a3b8",
        height: 40,
      },
      webPreferences: {
        preload: Path.join(__dirname, "preload.cjs"),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
      },
    });

    if (rendererEntryUrl) {
      await mainWindow.loadURL(rendererEntryUrl);
    } else {
      await mainWindow.loadFile(rendererEntryFile);
    }

    if (isDevelopment) {
      mainWindow.webContents.openDevTools({ mode: "detach" });
    }

    // Only hide-to-tray if tray is actually present and visible.
    // Use isQuitting flag to allow real quit via tray menu or app.quit().
    mainWindow.on("close", (event) => {
      if (isQuitting) return; // Let the window close normally

      const settings = settingsStore?.get();
      if (settings?.general.minimizeToTray && tray) {
        event.preventDefault();
        mainWindow?.hide();
      }
    });

    mainWindow.on("closed", () => {
      mainWindow = null;
    });
  };

  const settings = settingsStore.get();

  // Only create tray if minimizeToTray is explicitly enabled
  if (settings.general.minimizeToTray) {
    createTray();
  }

  // Wire launchOnStartup from persisted settings
  applyLoginItemSettings(settings.general.launchOnStartup);

  restartMonitoring(settings);
  await createWindow();

  // Check if launched with --start-minimized (from login item)
  const launchMinimized = settings.general.startMinimized ||
    process.argv.includes("--start-minimized");
  if (launchMinimized) {
    mainWindow?.hide();
  }

  // Auto-update check (production only)
  if (!isDevelopment) {
    try {
      const { autoUpdater } = require("electron-updater");
      autoUpdater.autoDownload = false;
      autoUpdater.autoInstallOnAppQuit = true;
      // Request UAC elevation if installed to a system directory (e.g. Program Files)
      if (process.platform === "win32") {
        autoUpdater.allowElevation = true;
      }
      autoUpdater.on("update-available", () => {
        sendToast("info", "Update available", "A new version of DiskHound is available.");
        autoUpdater.downloadUpdate();
      });
      autoUpdater.on("update-downloaded", () => {
        sendToast("success", "Update ready", "The update will be applied when you restart DiskHound.");
      });
      autoUpdater.on("error", () => { /* update check failed — offline or rate-limited */ });
      autoUpdater.checkForUpdates().catch(() => {});
    } catch {
      // electron-updater not available (dev mode or build issue)
    }
  }

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      void createWindow();
    }
  });

  app.on("before-quit", () => {
    isQuitting = true;
    if (activeScan) {
      void activeScan.stop();
      activeScan = null;
    }
    if (monitoringInterval) {
      clearInterval(monitoringInterval);
      monitoringInterval = null;
    }
    if (tray) {
      tray.destroy();
      tray = null;
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    const settings = settingsStore?.get();
    if (!settings?.general.minimizeToTray || !tray) {
      app.quit();
    }
  }
});

function formatBytesShort(bytes: number): string {
  if (bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const exp = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const val = bytes / 1024 ** exp;
  return `${val.toFixed(val >= 100 || exp === 0 ? 0 : 1)} ${units[exp]}`;
}
