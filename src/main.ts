import * as FS from "node:fs/promises";
import * as FS_SYNC from "node:fs";
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
  normalizeAppSettings,
  type AppSettings,
  type DirectoryHotspot,
  type PathActionResult,
  type ScanEngine,
  type ScanFileRecord,
  type ScanOptions,
  type ScanSnapshot,
  type SystemMemorySnapshot,
  type ToastMessage,
  type WorkerToMainMessage,
} from "./shared/contracts";
import {
  checkDiskDeltas,
  getDiskDeltaHistory,
  getDiskSpace,
  getLastFullScanAt,
  getMonitoringSnapshot,
  initDiskMonitor,
  markFullScan,
} from "./shared/diskMonitor";
import { createScanSnapshotStore } from "./shared/scanStore";
import { createSettingsStore, type SettingsStore } from "./shared/settingsStore";
import { easyMove, easyMoveBack, getEasyMoves, initEasyMoveStore } from "./shared/easyMoveStore";
import {
  consumeLastPrunedIds,
  getScanHistory,
  getLatestPair,
  initScanHistory,
  loadHistoricalSnapshot,
  saveScanToHistory,
} from "./shared/scanHistory";
import { computeDiff } from "./shared/scanDiff";
import {
  deleteIndex,
  diffIndexes,
  indexFilePath,
  initScanIndex,
  loadIndex,
  loadLargestFiles,
} from "./shared/scanIndex";
import { runDuplicateScan, type DuplicateScanHandle } from "./shared/duplicates";
import { randomUUID } from "node:crypto";
import { normPath } from "./shared/pathUtils";
import { analyzeForCleanup } from "./shared/suggestions";
import { killProcess as killProcessImpl, sampleSystemMemory } from "./shared/processMonitor";
import { initUsnCursorStore } from "./shared/usnCursorStore";
import {
  captureCursorAfterScan,
  getCursorForRoot,
  runIncrementalScan,
} from "./usnMonitor";
import { resolveNativeScannerBinary } from "./nativeScanner";
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
  trigger: "manual" | "scheduled";
  stop: () => Promise<void>;
  tempIndexPath?: string;
  rootPath: string;
};

type ActiveScanSession = (WorkerScanSession | NativeScannerSession) & {
  active: boolean;
  trigger: "manual" | "scheduled";
  tempIndexPath?: string;
  /** The scan root this session is working on. Used as the activeScans
   *  Map key so concurrent scans on different drives stay isolated. */
  rootPath: string;
};

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
/**
 * Per-root scan sessions. Keyed by normPath(rootPath) so a "C:\" key and a
 * "C:\\" key collide. Allows concurrent scans on different drives; a new
 * scan on the same root cancels the previous one for that root only.
 */
const activeScans: Map<string, ActiveScanSession> = new Map();
const scanKey = (rootPath: string): string => normPath(rootPath);
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

// Log startup diagnostics so "app silently fails to launch" is debuggable.
// Writes to %APPDATA%/DiskHound/startup.log (or equivalent on other OSes).
function writeStartupLog(message: string): void {
  try {
    const logPath = Path.join(app.getPath("userData"), "startup.log");
    FS.mkdir(Path.dirname(logPath), { recursive: true }).catch(() => {});
    FS.appendFile(logPath, `[${new Date().toISOString()}] ${message}\n`).catch(() => {});
  } catch { /* best effort */ }
}

// Surface uncaught exceptions so a silent crash at least shows up.
process.on("uncaughtException", (err) => {
  writeStartupLog(`UNCAUGHT: ${err?.stack ?? err?.message ?? String(err)}`);
  try {
    dialog.showErrorBox("DiskHound — Unexpected error", String(err?.stack ?? err?.message ?? err));
  } catch { /* noop */ }
});

void app.whenReady().then(async () => {
  writeStartupLog("whenReady fired");
  if (process.platform === "win32") {
    app.setAppUserModelId("com.diskhound.app");
  }

  const scanStore = await createScanSnapshotStore(app.getPath("userData"));
  settingsStore = await createSettingsStore();

  // Initialize disk monitor with persistent baseline storage
  await initDiskMonitor(app.getPath("userData"));
  // Prime the cached monitoring snapshot so the UI can show current drive state
  // without mutating baselines on first render.
  try {
    await checkDiskDeltas();
  } catch {
    // Best effort - monitoring remains optional
  }

  // Initialize easy-move store
  initEasyMoveStore(app.getPath("userData"));

  // Initialize scan history + full-file indexes
  initScanHistory(app.getPath("userData"));
  initScanIndex(app.getPath("userData"));
  await initUsnCursorStore(app.getPath("userData"));

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
        const historyId = await saveScanToHistory(message.snapshot);

        // Rename the temp index file to match the history entry ID
        if (historyId && session.tempIndexPath) {
          try {
            await FS.rename(session.tempIndexPath, indexFilePath(historyId));
          } catch {
            // Scanner may have skipped or failed to write the index — ignore
          }
        }

        // Delete index files for any history entries that just got pruned
        for (const prunedId of consumeLastPrunedIds()) {
          void deleteIndex(prunedId);
        }
      }

      await broadcastSnapshot(message.snapshot);
      if (message.type === "done") {
        session.active = false;
        // Only clear our slot if we're still the active session for this
        // root — a fast restart may have replaced us already.
        const key = scanKey(session.rootPath);
        if (activeScans.get(key) === session) {
          activeScans.delete(key);
        }
        markFullScan();

        // Phase-2b: capture the volume's current USN cursor so the next
        // monitoring tick can do a cheap incremental scan. Best-effort —
        // non-NTFS volumes, missing native binary, etc., will silently
        // skip capture and leave the next tick to fall back to full scan.
        if (message.snapshot.rootPath && message.snapshot.status === "done") {
          const binaryPath = resolveNativeScannerBinary(projectRoot);
          if (binaryPath) {
            void captureCursorAfterScan(binaryPath, message.snapshot.rootPath)
              .catch(() => { /* non-fatal */ });
          }
        }

        const settings = settingsStore?.get();

        // Record in recent scans, and auto-seed defaultRootPath so monitoring
        // has a target to rescan without the user having to set one manually.
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

          const shouldSeedDefaultPath =
            session.trigger === "manual" && !settings.scanning.defaultRootPath;
          const nextScanning = shouldSeedDefaultPath
            ? { ...settings.scanning, defaultRootPath: message.snapshot.rootPath }
            : settings.scanning;

          void settingsStore!.set({
            ...settings,
            scanning: nextScanning,
            recentScans: recent,
          });
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

        if (session.trigger === "scheduled" && settings?.notifications.deltaAlerts && message.snapshot.rootPath) {
          const latestPair = getLatestPair(message.snapshot.rootPath);
          if (latestPair) {
            const [baseline, current] = await Promise.all([
              loadHistoricalSnapshot(latestPair.baseline.id),
              loadHistoricalSnapshot(latestPair.current.id),
            ]);

            if (baseline && current) {
              const diff = computeDiff(baseline, current, latestPair.baseline.id, latestPair.current.id);
              if (diff.totalBytesDelta !== 0) {
                const grew = diff.totalBytesDelta > 0;
                const absBytes = formatBytesShort(Math.abs(diff.totalBytesDelta));
                sendToast(
                  grew ? "warning" : "success",
                  "Scheduled rescan found changes",
                  `${message.snapshot.rootPath} ${grew ? "grew" : "freed"} ${absBytes} since the previous full scan.`,
                );

                if (Notification.isSupported() && !mainWindow?.isVisible()) {
                  new Notification({
                    title: "DiskHound - Scheduled Rescan",
                    body: `${message.snapshot.rootPath} ${grew ? "grew" : "freed"} ${absBytes}.`,
                  }).show();
                }
              }
            }
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
    const key = scanKey(session.rootPath);
    if (activeScans.get(key) === session) {
      activeScans.delete(key);
    }
    // Clean up orphaned temp index file
    if (session.tempIndexPath) {
      try { await FS.unlink(session.tempIndexPath); } catch { /* already gone */ }
    }

    // If the native scanner failed to launch (ENOENT, EACCES), silently
    // fall back to the JS worker so the user still gets a scan.
    const errCode = (error as NodeJS.ErrnoException | undefined)?.code;
    if (
      session.kind === "native" &&
      startingSnapshot.rootPath &&
      (errCode === "ENOENT" || errCode === "EACCES")
    ) {
      console.warn(`[scan] native scanner unavailable (${errCode}) — falling back to JS worker`);
      const { session: fallbackSession, startingSnapshot: fallbackStart } = createWorkerSession(
        startingSnapshot.rootPath,
        startingSnapshot.scanOptions,
        session.trigger,
      );
      activeScans.set(scanKey(startingSnapshot.rootPath), fallbackSession);
      await broadcastSnapshot(fallbackStart);
      return;
    }

    await broadcastSnapshot(
      await buildErrorSnapshot(
        startingSnapshot,
        error instanceof Error ? error.message : String(error),
      ),
    );
  };

  /**
   * Locate the most recent completed scan's index file for the given root —
   * used as the Phase-1 baseline so the next scan can skip unchanged subtrees.
   * Returns undefined if no prior scan exists or if the index file is missing.
   */
  const resolveBaselineIndexFor = (rootPath: string): string | undefined => {
    const history = getScanHistory(rootPath);
    for (const entry of history) {
      const candidate = indexFilePath(entry.id);
      try {
        if (FS_SYNC.existsSync(candidate)) return candidate;
      } catch { /* ignore */ }
    }
    return undefined;
  };

  const createWorkerSession = (
    rootPath: string,
    scanOptions: ScanOptions,
    trigger: "manual" | "scheduled",
  ): { session: WorkerScanSession; startingSnapshot: ScanSnapshot } => {
    const worker = new Worker(scanWorkerEntry);
    const startingSnapshot = buildRunningSnapshot(rootPath, scanOptions, "js-worker");
    const tempIndexPath = indexFilePath(`pending-${randomUUID()}`);
    const baselineIndex = resolveBaselineIndexFor(rootPath);

    const session: WorkerScanSession = {
      kind: "worker",
      active: true,
      trigger,
      tempIndexPath,
      rootPath,
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

    // Scanner uses generous internal defaults — no user knobs here.
    worker.postMessage({
      type: "start",
      input: {
        rootPath,
        options: scanOptions,
        indexOutput: tempIndexPath,
        baselineIndex,
      },
    });

    return { session, startingSnapshot };
  };

  const createPreferredScanSession = (
    rootPath: string,
    scanOptions: ScanOptions,
    trigger: "manual" | "scheduled",
  ): { session: ActiveScanSession; startingSnapshot: ScanSnapshot } => {
    const nativeStartingSnapshot = buildRunningSnapshot(rootPath, scanOptions, "native-sidecar");
    const tempIndexPath = indexFilePath(`pending-${randomUUID()}`);
    const baselineIndex = resolveBaselineIndexFor(rootPath);

    // Buffer for messages that arrive before the session is fully wired
    const earlyMessages: WorkerToMainMessage[] = [];
    let earlyErrors: Error[] = [];
    let sessionRef: ActiveScanSession | null = null;

    const nativeResult = createNativeScannerSession(
      projectRoot,
      { rootPath, options: scanOptions, indexOutput: tempIndexPath, baselineIndex },
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
      sessionRef = Object.assign(nativeResult, { active: true, trigger, tempIndexPath, rootPath }) as ActiveScanSession;

      // Flush any messages that arrived during construction
      for (const msg of earlyMessages) {
        void handleRuntimeMessage(sessionRef, msg);
      }
      for (const err of earlyErrors) {
        void handleRuntimeFailure(sessionRef, nativeStartingSnapshot, err);
      }

      return { session: sessionRef, startingSnapshot: nativeStartingSnapshot };
    }

    return createWorkerSession(rootPath, scanOptions, trigger);
  };

  /**
   * Cancel the active scan for a specific root, or (when rootPath is
   * omitted) cancel ALL active scans. Used both by the IPC cancel
   * handler and by startScan() to retire a prior session on the same
   * root before starting fresh.
   */
  const cancelActiveScan = async (rootPathInput?: string) => {
    if (rootPathInput) {
      const rootPath = Path.resolve(rootPathInput);
      const key = scanKey(rootPath);
      const session = activeScans.get(key);
      if (!session) return null;
      activeScans.delete(key);
      await stopSession(session);
      return sendCancelledSnapshot(rootPath);
    }

    // Cancel all
    const sessions = Array.from(activeScans.values());
    activeScans.clear();
    for (const session of sessions) {
      await stopSession(session);
      await sendCancelledSnapshot(session.rootPath);
    }
    return null;
  };

  const stopSession = async (session: ActiveScanSession) => {
    session.active = false;
    try { await session.stop(); } catch { /* already dead */ }
    if (session.tempIndexPath) {
      try { await FS.unlink(session.tempIndexPath); } catch { /* already gone */ }
    }
  };

  const sendCancelledSnapshot = async (rootPath: string) => {
    const prior = await scanStore.get();
    if (normPath(prior.rootPath ?? "") !== normPath(rootPath)) {
      // The renderer's current-view snapshot is for a different root —
      // skip touching scanStore so we don't wipe that drive's state.
      return prior;
    }
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

  const startScan = async (
    rootPathInput: string,
    scanOptions: ScanOptions,
    trigger: "manual" | "scheduled" = "manual",
  ) => {
    const resolvedScanOptions = { ...defaultScanOptions(), ...scanOptions };
    const rootPath = Path.resolve(rootPathInput);
    // Cancel ONLY the session for this root (if any) — leave other
    // drives' scans running. This is what enables parallel multi-drive
    // scans: starting C: while D: is scanning no longer kills D:.
    await cancelActiveScan(rootPath);

    const { session, startingSnapshot } = createPreferredScanSession(
      rootPath,
      resolvedScanOptions,
      trigger,
    );
    activeScans.set(scanKey(rootPath), session);
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
  ipcMain.handle("diskhound:cancel-scan", (_event, rootPath?: string) => cancelActiveScan(rootPath));
  // New: tell the renderer which scans are currently running. Lets the
  // UI show per-drive progress indicators + avoid re-triggering a scan
  // that's already in flight.
  ipcMain.handle("diskhound:get-active-scan-roots", (): string[] => {
    return Array.from(activeScans.values()).map((s) => s.rootPath);
  });

  ipcMain.handle("diskhound:get-latest-snapshot-for-root", async (_event, rootPath: string) => {
    const history = getScanHistory(rootPath);
    const latest = history[0];
    if (!latest) return null;
    return await loadHistoricalSnapshot(latest.id);
  });

  // File icon cache keyed by extension (case-insensitive). Most files share
  // an extension, so we only hit the OS once per type.
  const iconCache = new Map<string, string | null>();

  ipcMain.handle("diskhound:get-file-icon", async (_event, filePath: string, size: "small" | "normal" | "large" = "small") => {
    const ext = Path.extname(filePath).toLowerCase() || "(no-ext)";
    const key = `${ext}:${size}`;
    if (iconCache.has(key)) return iconCache.get(key) ?? null;

    try {
      const image = await app.getFileIcon(filePath, { size });
      if (image.isEmpty()) {
        iconCache.set(key, null);
        return null;
      }
      const dataUrl = image.toDataURL();
      iconCache.set(key, dataUrl);
      return dataUrl;
    } catch {
      iconCache.set(key, null);
      return null;
    }
  });

  // ── IPC: Process / Memory viewer ──────────────────────────

  // Module-scope cache so subsequent calls (tab switches, renderer remounts)
  // can return instantly. A single in-flight promise dedupes concurrent
  // refresh requests so we don't stack PowerShell invocations.
  let memoryCache: SystemMemorySnapshot | null = null;
  let memorySamplePromise: Promise<SystemMemorySnapshot> | null = null;

  const refreshMemorySample = (): Promise<SystemMemorySnapshot> => {
    if (memorySamplePromise) return memorySamplePromise;
    memorySamplePromise = sampleSystemMemory()
      .then((snap) => {
        memoryCache = snap;
        memorySamplePromise = null;
        return snap;
      })
      .catch((err) => {
        memorySamplePromise = null;
        throw err;
      });
    return memorySamplePromise;
  };

  ipcMain.handle("diskhound:get-memory-snapshot", () => refreshMemorySample());

  // Instant cached read — returns null if nothing sampled yet. The renderer
  // uses this on mount to paint the list immediately, then kicks off a
  // real refresh in the background.
  ipcMain.handle("diskhound:get-cached-memory-snapshot", () => {
    if (!memoryCache) return null;
    return { ...memoryCache, isStale: true };
  });

  // Per-path icon cache for executables — unlike get-file-icon (which keys
  // by extension), each .exe typically has its OWN icon, so we must cache
  // by full path.
  const exeIconCache = new Map<string, string | null>();
  ipcMain.handle("diskhound:get-executable-icon", async (_event, filePath: string, size: "small" | "normal" | "large" = "small") => {
    if (!filePath) return null;
    const key = `${filePath}:${size}`;
    if (exeIconCache.has(key)) return exeIconCache.get(key) ?? null;
    try {
      const image = await app.getFileIcon(filePath, { size });
      if (image.isEmpty()) {
        exeIconCache.set(key, null);
        return null;
      }
      const dataUrl = image.toDataURL();
      exeIconCache.set(key, dataUrl);
      return dataUrl;
    } catch {
      exeIconCache.set(key, null);
      return null;
    }
  });

  ipcMain.handle("diskhound:kill-process", async (_event, pid: number, signal: "soft" | "hard"): Promise<PathActionResult> => {
    try {
      await killProcessImpl(pid, signal);
      return { ok: true, message: `Killed process ${pid}` };
    } catch (error) {
      return {
        ok: false,
        message: error instanceof Error ? error.message : String(error),
      };
    }
  });

  ipcMain.handle("diskhound:run-scheduled-scan-now", async () => {
    const settings = settingsStore?.get();
    if (!settings) return { ok: false, message: "Settings unavailable" };
    const path = settings.scanning.defaultRootPath;
    if (!path) {
      return { ok: false, message: "Set a default scan path first, or run a manual scan to auto-populate it." };
    }
    // Scan for the scheduled root — per-drive locking means we only
    // block if THIS root is already being scanned.
    const existingKey = scanKey(Path.resolve(path));
    if (activeScans.has(existingKey)) {
      return { ok: false, message: `A scan is already running for ${path}.` };
    }
    await startScan(path, defaultScanOptions(), "scheduled");
    return { ok: true, message: `Scheduled rescan started for ${path}` };
  });

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
    const normalizedSettings = normalizeAppSettings(settings);

    await settingsStore!.set(normalizedSettings);

    // Wire launchOnStartup to OS login items
    if (normalizedSettings.general.launchOnStartup !== previousSettings.general.launchOnStartup) {
      applyLoginItemSettings(normalizedSettings.general.launchOnStartup);
    }

    // Recreate tray or destroy it based on minimizeToTray toggle
    if (normalizedSettings.general.minimizeToTray && !tray) {
      createTray();
    } else if (!normalizedSettings.general.minimizeToTray && tray) {
      tray.destroy();
      tray = null;
    }

    restartMonitoring(normalizedSettings);
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

  // Tiny LRU cache so flicking between recent baselines in the Changes-tab
  // sidebar doesn't re-read + re-parse the same multi-megabyte JSON each
  // time. We keep up to 8 parsed snapshots in memory (~8-16 MB worst case)
  // — older entries get evicted on insert.
  const snapshotCache = new Map<string, ScanSnapshot>();
  const SNAPSHOT_CACHE_LIMIT = 8;
  const loadHistoricalSnapshotCached = async (id: string): Promise<ScanSnapshot | null> => {
    const cached = snapshotCache.get(id);
    if (cached) {
      // LRU: re-insert moves to end of insertion order
      snapshotCache.delete(id);
      snapshotCache.set(id, cached);
      return cached;
    }
    const snap = await loadHistoricalSnapshot(id);
    if (snap) {
      if (snapshotCache.size >= SNAPSHOT_CACHE_LIMIT) {
        const firstKey = snapshotCache.keys().next().value;
        if (firstKey) snapshotCache.delete(firstKey);
      }
      snapshotCache.set(id, snap);
    }
    return snap;
  };

  ipcMain.handle("diskhound:compute-scan-diff", async (_event, baselineId: string, currentId: string) => {
    const [baseline, current] = await Promise.all([
      loadHistoricalSnapshotCached(baselineId),
      loadHistoricalSnapshotCached(currentId),
    ]);
    if (!baseline || !current) return null;
    return computeDiff(baseline, current, baselineId, currentId);
  });

  ipcMain.handle("diskhound:compute-full-scan-diff", async (_event, baselineId: string, currentId: string, limit?: number) => {
    const [baseline, current] = await Promise.all([
      loadIndex(indexFilePath(baselineId)),
      loadIndex(indexFilePath(currentId)),
    ]);
    if (baseline.size === 0 && current.size === 0) return null;
    return diffIndexes(baselineId, currentId, baseline, current, limit ?? 500);
  });

  // Load a dense file list for the treemap from the persisted full-file index.
  // Returns the top N files by size across the whole scan (not just the
  // top-N tracked in memory). Used for WinDirStat-style dense visualization.
  ipcMain.handle("diskhound:get-treemap-files", async (_event, rootPath: string, limit: number = 10_000) => {
    const pair = getLatestPair(rootPath);
    const history = getScanHistory(rootPath);
    const currentId = pair?.current.id ?? history[0]?.id;
    if (!currentId) return [];
    try {
      const records = await loadLargestFiles(indexFilePath(currentId), limit, 0);
      // Map to the ScanFileRecord shape the renderer expects
      return records.map((r) => {
        const name = Path.basename(r.p);
        const parentPath = Path.dirname(r.p);
        const dotIdx = name.lastIndexOf(".");
        const extension = dotIdx > 0 ? name.slice(dotIdx).toLowerCase() : "(no ext)";
        return {
          path: r.p,
          name,
          parentPath,
          extension,
          size: r.s,
          modifiedAt: r.m,
        };
      });
    } catch {
      return [];
    }
  });

  ipcMain.handle("diskhound:get-latest-diff", async (_event, rootPath: string) => {
    const pair = getLatestPair(rootPath);
    if (!pair) return null;
    const [baseline, current] = await Promise.all([
      loadHistoricalSnapshotCached(pair.baseline.id),
      loadHistoricalSnapshotCached(pair.current.id),
    ]);
    if (!baseline || !current) return null;
    return computeDiff(baseline, current, pair.baseline.id, pair.current.id);
  });

  // ── IPC: Monitoring ───────────────────────────────────────

  ipcMain.handle("diskhound:get-monitoring-snapshot", () => getMonitoringSnapshot());
  ipcMain.handle("diskhound:get-disk-delta-history", () => getDiskDeltaHistory());
  ipcMain.handle("diskhound:get-scan-schedule-info", () => {
    const settings = settingsStore?.get();
    const lastScan = getLastFullScanAt();
    const intervalMin = settings?.monitoring.fullScanIntervalMinutes ?? 0;
    const enabled = Boolean(settings?.monitoring.enabled);
    const nextScanAt =
      enabled && intervalMin > 0 && lastScan !== null
        ? lastScan + intervalMin * 60_000
        : null;
    return {
      enabled,
      intervalMinutes: intervalMin,
      lastScanAt: lastScan,
      nextScanAt,
      defaultRootPath: settings?.scanning.defaultRootPath ?? "",
    };
  });
  ipcMain.handle("diskhound:get-disk-space", () => getDiskSpace());

  // ── IPC: Cleanup Analysis ─────────────────────────────────

  ipcMain.handle("diskhound:analyze-cleanup", (_event, rootPath: string, files: ScanFileRecord[], dirs: DirectoryHotspot[]) => {
    const settings = settingsStore!.get();
    return analyzeForCleanup(rootPath, files, dirs, settings.cleanup);
  });

  // ── IPC: Duplicate Detection ────────────────────────────

  ipcMain.handle("diskhound:start-duplicate-scan", (_event, rootPath: string, options?: { minSizeBytes?: number }) => {
    if (activeDuplicateScan) {
      activeDuplicateScan.cancel();
      activeDuplicateScan = null;
    }

    // Try to find an existing scan index whose root is an ancestor of the
    // duplicates scope — streaming that index is much faster and lower
    // memory than re-walking the filesystem. Fall back to walk if no
    // suitable index exists or if the path isn't under any known scan.
    const resolvedRoot = Path.resolve(rootPath);
    const indexPath = findIndexCoveringPath(resolvedRoot);

    activeDuplicateScan = runDuplicateScan(
      resolvedRoot,
      {
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
      },
      {
        indexPath,
        minSizeBytes: options?.minSizeBytes,
      },
    );
  });

  /**
   * Search the scan-history index for the most recent scan whose root
   * is either equal to or an ancestor of `path`. Returns the absolute
   * path to that scan's gzipped NDJSON, or null if no match.
   *
   * We prefer shorter (more ancestral) roots when multiple cover the
   * target, because those indexes contain the fullest dataset. For the
   * common case where a user scans `C:\` then runs duplicates on
   * `C:\Users\foo`, this finds the `C:\` index correctly.
   */
  function findIndexCoveringPath(path: string): string | null {
    const normalizedTarget = Path.resolve(path).toLowerCase();
    // Walk all known history entries, pick the best (shortest root path
    // that still covers our target, most recently scanned among those).
    let best: { id: string; rootLen: number; scannedAt: number } | null = null;
    const now = Date.now();
    // Iterate through all roots we've ever scanned. The history store
    // doesn't expose "all roots", so we scan the settings' recent list
    // (which is bounded) and fall back to no-match.
    const currentSettings = settingsStore?.get();
    const recent = currentSettings?.recentScans ?? [];
    for (const r of recent) {
      const normalizedRoot = Path.resolve(r.path).toLowerCase();
      const isUnder = normalizedTarget === normalizedRoot ||
        normalizedTarget.startsWith(normalizedRoot + Path.sep) ||
        normalizedTarget.startsWith(normalizedRoot + "/");
      if (!isUnder) continue;
      const history = getScanHistory(r.path);
      const latest = history[0];
      if (!latest) continue;
      const candidate = indexFilePath(latest.id);
      if (!FS_SYNC.existsSync(candidate)) continue;
      // Prefer shorter root. Among equal lengths, most recent wins.
      if (
        !best ||
        normalizedRoot.length < best.rootLen ||
        (normalizedRoot.length === best.rootLen && latest.scannedAt > best.scannedAt)
      ) {
        best = { id: latest.id, rootLen: normalizedRoot.length, scannedAt: latest.scannedAt };
      }
    }
    // Unused — keeps "now" available if we later add age cutoffs.
    void now;
    return best ? indexFilePath(best.id) : null;
  }

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
      // `--autostart` signals "the OS auto-launched us at login" — only
      // then does startMinimized take effect. Manual launches, post-
      // install launches (NSIS "Finish"), and post-update restarts all
      // come without this flag and therefore always show the window.
      //
      // Old flag name `--start-minimized` is still accepted at parse
      // time so existing login-item entries from <= v0.2.15 keep
      // working until applyLoginItemSettings() runs again and rewrites
      // them.
      app.setLoginItemSettings({
        openAtLogin: enabled,
        args: enabled ? ["--autostart"] : [],
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

      const excludedSet = new Set(
        (settings.monitoring.excludedDrives ?? []).map((d) => d.toUpperCase()),
      );
      for (const delta of snapshot.deltas) {
        // Respect per-drive opt-out — users can exclude specific drives
        // (backup disks, network shares, etc.) from alerts while keeping
        // monitoring globally enabled. We still emit the raw delta to
        // the renderer so the free-space gauge at the top stays accurate;
        // we just suppress the toast/system notification.
        const isExcluded = excludedSet.has(delta.drive.toUpperCase());
        if (!isExcluded) {
          mainWindow?.webContents.send(DISK_DELTA_CHANNEL, delta);
        }

        // Only alert on free-space DECREASES (negative deltaBytes)
        if (delta.deltaBytes >= 0) continue; // Space increased — not actionable
        if (isExcluded) continue;

        const decrease = Math.abs(delta.deltaBytes);
        const decreasePct = Math.abs(delta.deltaPercent);
        const shouldAlert =
          decrease >= settings.monitoring.alertThresholdBytes ||
          decreasePct >= settings.monitoring.alertThresholdPercent;

        if (shouldAlert && settings.notifications.deltaAlerts) {
          sendToast("warning", "Free space decreased",
            `${delta.drive}: lost ${formatBytesShort(decrease)} since last check.`);

          if (Notification.isSupported() && !mainWindow?.isVisible()) {
            new Notification({
              title: "DiskHound - Free Space Decreased",
              body: `${delta.drive}: lost ${formatBytesShort(decrease)}.`,
            }).show();
          }
        }
      }

      // Scheduled rescan if interval has elapsed. Phase 2b adds an
      // incremental-first path: if we have a valid USN cursor for the
      // root's volume, try reading the journal before spinning up a full
      // scan. If incremental fails for any reason, fall through to full.
      if (settings.monitoring.fullScanIntervalMinutes > 0) {
        const lastScan = getLastFullScanAt();
        const intervalMs = settings.monitoring.fullScanIntervalMinutes * 60_000;
        const now = Date.now();

        if (lastScan === null || now - lastScan >= intervalMs) {
          const defaultPath = settings.scanning.defaultRootPath;
          const alreadyScanning = defaultPath
            ? activeScans.has(scanKey(Path.resolve(defaultPath)))
            : false;
          if (defaultPath && !alreadyScanning) {
            const incrementalWorked = await tryIncrementalScan(defaultPath);
            if (!incrementalWorked) {
              void startScan(defaultPath, defaultScanOptions(), "scheduled");
              const intervalLabel = formatScanIntervalLabel(settings.monitoring.fullScanIntervalMinutes);
              sendToast("info", "Scheduled rescan started",
                `Rescanning ${defaultPath} after ${intervalLabel} interval.`);
            }
          }
        }
      }
    }, checkMs);
  };

  /**
   * Attempt an incremental (USN-journal) rescan. Returns true if it
   * succeeded and a new snapshot was broadcast — caller skips the full
   * rescan. Returns false if we couldn't run incremental (no cursor, no
   * binary, parse error, wrap, etc), in which case caller does full.
   */
  const tryIncrementalScan = async (rootPath: string): Promise<boolean> => {
    // Explicit diagnostics at every fall-off path so users can run
    // `electron . --inspect` (or just tail the console) and see WHY
    // deltas aren't firing instead of silent-fallback to full scan.
    const binaryPath = resolveNativeScannerBinary(projectRoot);
    if (!binaryPath) {
      console.error(`[monitoring] delta skipped — native scanner binary not found for ${rootPath}`);
      return false;
    }

    const cursor = getCursorForRoot(rootPath);
    if (!cursor) {
      console.error(`[monitoring] delta skipped — no USN cursor captured yet for ${rootPath}. ` +
        `A cursor is recorded after the first full scan completes.`);
      return false;
    }

    // Find the most recent index for this root to serve as the delta base.
    const history = getScanHistory(rootPath);
    const mostRecent = history[0];
    if (!mostRecent) {
      console.error(`[monitoring] delta skipped — no scan history for ${rootPath}`);
      return false;
    }
    const previousIndexPath = indexFilePath(mostRecent.id);
    if (!FS_SYNC.existsSync(previousIndexPath)) {
      console.error(`[monitoring] delta skipped — previous index missing at ${previousIndexPath}`);
      return false;
    }

    const newIndexPath = indexFilePath(`pending-${randomUUID()}`);

    let result;
    try {
      result = await runIncrementalScan({
        rootPath,
        scannerPath: binaryPath,
        previousIndexPath,
        newIndexPath,
        cursor,
      });
    } catch (error) {
      console.error(`[monitoring] delta spawn/parse failed for ${rootPath}:`, error);
      try { await FS.unlink(newIndexPath); } catch { /* ignore */ }
      return false;
    }

    if (!result) {
      // Common causes: journal wrap past our cursor, journal ID mismatch
      // (volume reformatted), volume not NTFS. runIncrementalScan logs
      // specifics via its Rust-side error line.
      console.error(`[monitoring] delta returned null for ${rootPath} — likely journal wrap or ID mismatch. Full scan will run.`);
      try { await FS.unlink(newIndexPath); } catch { /* ignore */ }
      return false;
    }

    // Save the incremental result to history and update cursor.
    const historyId = await saveScanToHistory(result.snapshot);
    if (!historyId) {
      try { await FS.unlink(newIndexPath); } catch { /* ignore */ }
      return false;
    }

    try {
      await FS.rename(newIndexPath, indexFilePath(historyId));
    } catch { /* ignore */ }

    for (const prunedId of consumeLastPrunedIds()) {
      void deleteIndex(prunedId);
    }

    await broadcastSnapshot(result.snapshot);
    markFullScan();

    // Persist the new cursor so the NEXT tick picks up from here.
    await import("./shared/usnCursorStore").then((m) => m.setCursor(result!.newCursor));

    // Always surface the delta scan result — "no changes" is itself a
    // signal users want to see ("my monitoring is working"). Without
    // this toast a silent zero-change delta is indistinguishable from
    // monitoring being broken.
    if (settings.notifications.scanComplete) {
      const { additions, modifications, deletions, elapsedMs } = result.stats;
      const totalChanges = additions + modifications + deletions;
      if (totalChanges > 0) {
        sendToast("info", "Delta scan · changes detected",
          `${totalChanges} change(s) in ${elapsedMs}ms: +${additions} / ~${modifications} / -${deletions}`);
      } else {
        sendToast("info", "Delta scan · no changes",
          `Checked ${rootPath} in ${elapsedMs}ms via the NTFS journal.`);
      }
    }
    // Stderr log as a fallback observability hook — the user can tail
    // the Electron console to confirm deltas are firing, even when
    // toasts are disabled or off-screen.
    console.error(
      `[monitoring] delta scan for ${rootPath}: ` +
      `+${result.stats.additions}/~${result.stats.modifications}/-${result.stats.deletions} ` +
      `(${result.stats.elapsedMs}ms, ${result.stats.recordsRead} journal records)`,
    );

    return true;
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

  let settings = settingsStore.get();
  const normalizedSettings = normalizeAppSettings(settings);
  if (JSON.stringify(normalizedSettings) !== JSON.stringify(settings)) {
    await settingsStore.set(normalizedSettings);
    settings = normalizedSettings;
  }

  // Only create tray if minimizeToTray is explicitly enabled
  if (settings.general.minimizeToTray) {
    createTray();
  }

  // Wire launchOnStartup from persisted settings
  applyLoginItemSettings(settings.general.launchOnStartup);

  restartMonitoring(settings);
  await createWindow();
  writeStartupLog("window created and loaded");

  // "Start minimized" is an AUTOSTART-ONLY preference — we want a
  // fresh-install launch, a post-update restart, and a user-initiated
  // double-click to all surface the window, even when the user has
  // opted into starting minimized on OS login. The distinguishing
  // signal is the `--autostart` arg that applyLoginItemSettings wires
  // into the registered login item. Legacy flag `--start-minimized`
  // stays recognised so installs that ran on ≤ v0.2.15 don't
  // double-foreground on their next OS-login launch before Settings
  // is opened (which rewrites the arg).
  const wasAutoStarted =
    process.argv.includes("--autostart") ||
    process.argv.includes("--start-minimized");
  const canLaunchToTray = settings.general.minimizeToTray && Boolean(tray);
  const launchMinimized =
    canLaunchToTray && wasAutoStarted && settings.general.startMinimized;
  if (launchMinimized) {
    mainWindow?.hide();
  }

  // Auto-update (production only, gated on user setting)
  let autoUpdater: any = null;
  const UPDATE_STATUS_CHANNEL = "diskhound:update-status";
  const currentVersion = app.getVersion();

  const emitUpdateStatus = (status: import("./shared/contracts").UpdateStatus) => {
    mainWindow?.webContents.send(UPDATE_STATUS_CHANNEL, status);
  };

  if (!isDevelopment) {
    try {
      autoUpdater = require("electron-updater").autoUpdater;
      autoUpdater.autoDownload = false;
      autoUpdater.autoInstallOnAppQuit = true;
      // Per-user install location (LocalAppData) doesn't need elevation; setting
      // this false lets the silent updater run without a UAC prompt.
      autoUpdater.allowElevation = false;

      autoUpdater.on("checking-for-update", () => {
        emitUpdateStatus({ phase: "checking", currentVersion });
      });
      autoUpdater.on("update-available", (info: any) => {
        emitUpdateStatus({ phase: "available", currentVersion, availableVersion: info?.version });
        sendToast("info", "Update available", `DiskHound ${info?.version ?? ""} is available. Downloading...`);
        autoUpdater.downloadUpdate().catch(() => {});
      });
      autoUpdater.on("update-not-available", (info: any) => {
        emitUpdateStatus({ phase: "up-to-date", currentVersion, availableVersion: info?.version });
      });
      autoUpdater.on("download-progress", (p: any) => {
        emitUpdateStatus({ phase: "downloading", currentVersion, downloadPercent: Math.round(p?.percent ?? 0) });
      });
      autoUpdater.on("update-downloaded", (info: any) => {
        emitUpdateStatus({ phase: "downloaded", currentVersion, availableVersion: info?.version });
        sendToast("success", "Update ready", "Restart DiskHound to apply the update.");
      });
      autoUpdater.on("error", (err: Error) => {
        emitUpdateStatus({ phase: "error", currentVersion, errorMessage: err?.message });
      });

      // Check on boot only if the user has auto-update enabled
      if (settings.general.autoUpdate) {
        autoUpdater.checkForUpdates().catch(() => {});
      }
    } catch {
      // electron-updater not available (dev mode or build issue)
    }
  }

  ipcMain.handle("diskhound:check-for-updates", async () => {
    if (!autoUpdater) return;
    try { await autoUpdater.checkForUpdates(); } catch { /* ignore */ }
  });

  ipcMain.on("diskhound:quit-and-install", () => {
    if (!autoUpdater) return;
    isQuitting = true;
    // Silent install + auto-relaunch after update.
    // isSilent=true → skip NSIS UI; isForceRunAfter=true → relaunch DiskHound once install finishes.
    try { autoUpdater.quitAndInstall(true, true); } catch { /* ignore */ }
  });

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      void createWindow();
    }
  });

  app.on("before-quit", () => {
    isQuitting = true;
    for (const session of activeScans.values()) {
      void session.stop();
    }
    activeScans.clear();
    if (monitoringInterval) {
      clearInterval(monitoringInterval);
      monitoringInterval = null;
    }
    if (tray) {
      tray.destroy();
      tray = null;
    }
  });
}).catch((err) => {
  writeStartupLog(`whenReady rejected: ${err?.stack ?? err?.message ?? String(err)}`);
  try {
    dialog.showErrorBox("DiskHound — Startup failed", String(err?.stack ?? err?.message ?? err));
  } catch { /* noop */ }
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

function formatScanIntervalLabel(minutes: number): string {
  if (minutes < 60) return `${minutes}m`;
  const hours = minutes / 60;
  if (hours < 24) {
    return Number.isInteger(hours) ? `${hours}h` : `${hours.toFixed(1)}h`;
  }
  const days = hours / 24;
  return Number.isInteger(days) ? `${days}d` : `${days.toFixed(1)}d`;
}
