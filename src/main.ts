import * as FS from "node:fs/promises";
import * as FS_SYNC from "node:fs";
import { createReadStream } from "node:fs";
import * as Path from "node:path";
import { createInterface } from "node:readline";
import { Worker } from "node:worker_threads";
import { createGunzip, createGzip } from "node:zlib";

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
  type AffinityRule,
  type AppSettings,
  type DirectoryHotspot,
  type FullDiffStatus,
  type FullDiffResult,
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
import { createWindowStateStore, type WindowStateStore } from "./shared/windowStateStore";
import {
  easyMove,
  easyMoveBack,
  getEasyMoves,
  initEasyMoveStore,
  setEasyMoveLogger,
  setEasyMoveProgress,
  verifyEasyMoves,
} from "./shared/easyMoveStore";
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
  folderTreeSidecarPath,
  indexFilePath,
  initScanIndex,
} from "./shared/scanIndex";
import { runDuplicateScan, type DuplicateScanHandle } from "./shared/duplicates";
import { randomUUID } from "node:crypto";
import { normPath } from "./shared/pathUtils";
import { analyzeForCleanup } from "./shared/suggestions";
import { killProcess as killProcessImpl, sampleSystemMemory } from "./shared/processMonitor";
import {
  computeFullDiffFromIndexFiles,
  resolveBundledFullDiffWorkerPath,
  runFullDiffWorker,
} from "./shared/fullDiffWorkerRuntime";
import {
  resolveBundledFolderTreeWorkerPath,
  runFolderTreeWorker,
} from "./shared/folderTreeWorkerRuntime";
import {
  deleteFullDiffCachesForScan,
  hasFullDiffCache,
  initFullDiffCacheStore,
  readFullDiffCache,
  writeFullDiffCache,
} from "./shared/fullDiffCacheStore";
import { createTreemapCache } from "./shared/treemapCache";
import { initUsnCursorStore } from "./shared/usnCursorStore";
import {
  captureCursorAfterScan,
  checkUsnForAnyChanges,
  getCursorForRoot,
  runIncrementalScan,
} from "./usnMonitor";
import { setCursor, volumeForPath } from "./shared/usnCursorStore";
import { resolveNativeScannerBinary } from "./nativeScanner";
import { createNativeScannerSession, type NativeScannerSession } from "./nativeScanner";
import * as elevationModule from "./elevation";

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
const fullDiffWorkerEntry = resolveBundledFullDiffWorkerPath(__dirname);
const folderTreeWorkerEntry = resolveBundledFolderTreeWorkerPath(__dirname);
const RELEASES_URL = "https://github.com/tzarebczan/diskhound/releases";

type WorkerScanSession = {
  kind: "worker";
  active: boolean;
  trigger: "manual" | "scheduled";
  stop: () => Promise<void>;
  tempIndexPath?: string;
  tempFolderTreePath?: string;
  rootPath: string;
};

type ActiveScanSession = (WorkerScanSession | NativeScannerSession) & {
  active: boolean;
  trigger: "manual" | "scheduled";
  tempIndexPath?: string;
  /** Temp path the scanner emits its folder-tree sidecar to during the
   *  run. Renamed to `folderTreeSidecarPath(historyId)` on success so
   *  the Folders-tab loader can skip the multi-minute NDJSON re-parse. */
  tempFolderTreePath?: string;
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
/**
 * Per-root duplicate scans. Lets users kick off duplicate detection on
 * multiple drives in parallel without one cancelling the other, and
 * preserves a running scan when the user navigates away and back.
 * Key: normPath(rootPath). Value: the handle returned by runDuplicateScan.
 */
const activeDuplicateScans: Map<string, DuplicateScanHandle> = new Map();
let monitoringInterval: ReturnType<typeof setInterval> | null = null;
let settingsStore: SettingsStore | null = null;
let windowStateStore: WindowStateStore | null = null;
// Track whether the user explicitly quit (vs. close-to-tray)
let isQuitting = false;

app.commandLine.appendSwitch("enable-gpu-rasterization");
app.commandLine.appendSwitch("enable-oop-rasterization");
app.commandLine.appendSwitch("enable-zero-copy");

// Disable Chromium's background throttling of timers / renderer / IPC.
// Without these, alt-tabbing away from DiskHound while a long scan is
// running freezes the scan-progress UI and stalls setInterval/IPC
// delivery for seconds at a time (Chromium aggressively throttles
// hidden or occluded windows). We want progress heartbeats and the
// [memory] interval to keep ticking regardless of focus state.
app.commandLine.appendSwitch("disable-renderer-backgrounding");
app.commandLine.appendSwitch("disable-background-timer-throttling");
app.commandLine.appendSwitch("disable-backgrounding-occluded-windows");

// Raise V8's old-generation heap ceiling for the main process from the
// default ~4 GB to 8 GB. On big drives (1M+ directories) the post-scan
// pipeline briefly holds BOTH the old cached folder tree (evicted just
// after) AND the newly-built one (being pre-warmed) — heapTotal spikes
// past 4 GB and V8 hard-aborts the process with NO crash-log line,
// because the abort bypasses our uncaughtException/unhandledRejection
// handlers. Observed in the wild: RSS 3886 MB + heapTotal 3524 MB right
// before the process vanished at 17:11:05 (see crash.log).
//
// Extra ceiling only commits pages when touched; the common case pays
// nothing. 8 GB is comfortable on a modern 16+ GB machine and still
// leaves room for renderer + GPU + tray processes.
app.commandLine.appendSwitch("js-flags", "--max-old-space-size=8192");
if (process.platform === "linux") {
  app.commandLine.appendSwitch("class", "diskhound");
}

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

function resolveAppIconPath(): string | null {
  const iconPaths = [
    Path.join(process.resourcesPath ?? projectRoot, "icon.png"),
    Path.join(projectRoot, "build", "icon.png"),
  ];

  for (const iconPath of iconPaths) {
    try {
      if (FS_SYNC.existsSync(iconPath)) {
        return iconPath;
      }
    } catch {
      // Try the next fallback.
    }
  }

  return null;
}

function resolveIconsDir(): string | null {
  const dirs = [
    Path.join(process.resourcesPath ?? projectRoot, "icons"),
    Path.join(projectRoot, "build", "icons"),
  ];
  for (const dir of dirs) {
    try {
      if (FS_SYNC.existsSync(dir) && FS_SYNC.statSync(dir).isDirectory()) {
        return dir;
      }
    } catch { /* try next */ }
  }
  return null;
}

/**
 * Build a window icon with every size we ship as a separate
 * representation. Linux window managers read _NET_WM_ICON as a list
 * of (w, h, ARGB) tuples and pick the best match for each chrome
 * target (dock 48 px, title-bar 16/24 px, Alt-Tab switcher 128 px,
 * Activities overview 256 px, etc.). Passing one 512×512 PNG forces
 * them to downscale — fine for a simple logo, terrible for the
 * DiskHound treemap tiles which alias into an unreadable smudge at
 * 16 px. With explicit 16/24/32/48/64/128/256/512 reps the WM picks
 * the pre-rendered one and the sidebar + title-bar icons both look
 * crisp.
 *
 * Returns null if neither the packaged nor the dev icons/ directory
 * exists — caller falls back to the single-size 512 PNG.
 */
function createAppIconImage(): Electron.NativeImage | null {
  const iconsDir = resolveIconsDir();
  if (!iconsDir) return null;

  const sizes = [512, 256, 128, 64, 48, 32, 24, 16];
  const base = nativeImage.createEmpty();
  let added = 0;

  for (const size of sizes) {
    const pngPath = Path.join(iconsDir, `${size}x${size}.png`);
    try {
      if (!FS_SYNC.existsSync(pngPath)) continue;
      const img = nativeImage.createFromPath(pngPath);
      if (img.isEmpty()) continue;
      if (added === 0) {
        // First representation becomes the base; subsequent calls add
        // extra scale factors. We use 1x as the base scale and express
        // the others as fractional scaleFactors relative to it — this
        // is how Electron's NativeImage lets you bundle multiple pixel
        // densities for a single logical image.
        base.addRepresentation({
          scaleFactor: 1,
          width: size,
          height: size,
          buffer: img.toPNG(),
        });
      } else {
        // Anchor scaleFactor off the base (512 → 1.0). Linux WMs read
        // all reps out of the NativeImage regardless of scaleFactor
        // semantics, but keeping the ratios honest avoids surprising
        // HiDPI tray-icon behavior on macOS if we ever reuse this
        // image there.
        base.addRepresentation({
          scaleFactor: size / sizes[0],
          width: size,
          height: size,
          buffer: img.toPNG(),
        });
      }
      added += 1;
    } catch {
      // Skip a bad file, keep whatever reps we've collected.
    }
  }

  return added > 0 ? base : null;
}

function createTrayIconImage(): Electron.NativeImage {
  const iconPath = resolveAppIconPath();
  if (iconPath) {
    try {
      const icon = nativeImage.createFromPath(iconPath);
      return icon.resize({ width: 16, height: 16 });
    } catch {
      // Fall through to the generated fallback below.
    }
  }

  // Fallback: simple amber square if icon file not found
  const size = 16;
  const buf = Buffer.alloc(size * size * 4);
  for (let i = 0; i < size * size; i++) {
    buf[i * 4] = 11; buf[i * 4 + 1] = 158; buf[i * 4 + 2] = 245; buf[i * 4 + 3] = 255;
  }
  return nativeImage.createFromBitmap(buf, { width: size, height: size });
}

// ─ Crash + diagnostic logging ────────────────────────────────────────────
//
// We write to %APPDATA%/DiskHound/crash.log (cross-platform: userData).
// The same file covers startup diagnostics, main-process exceptions,
// unhandled rejections, renderer errors (forwarded via IPC), and scan
// worker failures. The Settings UI has a "View crash logs" button so
// users can zip-and-send the file when asking for help.
//
// Bounded by simple size-based rotation — once the file exceeds
// CRASH_LOG_MAX_BYTES, we rename it to crash.log.old so we always keep
// at least one archived copy without growing unbounded over months.

const CRASH_LOG_FILENAME = "crash.log";
const CRASH_LOG_ARCHIVE_FILENAME = "crash.log.old";
const CRASH_LOG_MAX_BYTES = 1 * 1024 * 1024; // 1 MiB

function crashLogPath(): string {
  return Path.join(app.getPath("userData"), CRASH_LOG_FILENAME);
}
function crashLogArchivePath(): string {
  return Path.join(app.getPath("userData"), CRASH_LOG_ARCHIVE_FILENAME);
}

async function maybeRotateCrashLog(): Promise<void> {
  try {
    const stat = await FS.stat(crashLogPath());
    if (stat.size > CRASH_LOG_MAX_BYTES) {
      await FS.rename(crashLogPath(), crashLogArchivePath()).catch(() => {});
    }
  } catch {
    // missing file is fine — nothing to rotate
  }
}

/**
 * Append a timestamped line to crash.log. Categorized by `tag` so it's
 * easy to grep for a specific failure class when triaging.
 */
function writeCrashLog(tag: string, message: string): void {
  const line = `[${new Date().toISOString()}] [${tag}] ${message}\n`;
  try {
    const logPath = crashLogPath();
    FS.mkdir(Path.dirname(logPath), { recursive: true }).catch(() => {});
    FS.appendFile(logPath, line).catch(() => {});
  } catch { /* best effort */ }
  // Rotate opportunistically — cheap check, runs on a microtask so it
  // doesn't block the writer.
  void maybeRotateCrashLog();
}

// Back-compat alias — older call sites still use writeStartupLog.
function writeStartupLog(message: string): void {
  writeCrashLog("startup", message);
}

// Surface uncaught exceptions so a silent crash at least shows up and
// leaves breadcrumbs in crash.log.
process.on("uncaughtException", (err) => {
  writeCrashLog("main-uncaught", err?.stack ?? err?.message ?? String(err));
  try {
    dialog.showErrorBox("DiskHound — Unexpected error", String(err?.stack ?? err?.message ?? err));
  } catch { /* noop */ }
});

process.on("unhandledRejection", (reason) => {
  const err = reason instanceof Error ? reason : new Error(String(reason));
  writeCrashLog("main-rejection", err.stack ?? err.message);
});

/**
 * Summarize main-process memory usage in a one-line-friendly string.
 * Called from the periodic diagnostic + on demand (e.g. when a user
 * clicks "Refresh" in the crash-log viewer).
 */
function describeMemoryUsage(): string {
  const mb = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(0)} MB`;
  const mem = process.memoryUsage();
  return `rss=${mb(mem.rss)} heapUsed=${mb(mem.heapUsed)} heapTotal=${mb(mem.heapTotal)} external=${mb(mem.external)} arrayBuffers=${mb(mem.arrayBuffers)}`;
}

// ─ Single-instance lock ────────────────────────────────────────────────────
//
// Only one DiskHound window should ever be up — double-click shortcut,
// post-crash relaunch, file-manager "Open" etc. shouldn't spawn
// duplicates that race to rebuild the folder-tree cache or corrupt the
// shared index files.
//
// Three elevation-related scenarios have to ALL work without the user
// ever seeing "nothing happened":
//
//   A. Normal duplicate launch (user double-clicks shortcut twice):
//      second instance fails lock → focus existing → exit. Quick.
//   B. Scheduled-task auto-relaunch: non-elevated parent triggers task,
//      parent waits ~2.5 s to verify elevated sibling then quits. The
//      elevated child hits whenReady before parent quits, so it needs
//      to wait for the lock.
//   C. User hits "Relaunch as admin" in Settings: parent invokes
//      Start-Process -Verb RunAs, schedules its own quit in 500 ms.
//      The elevated child starts BEFORE the parent quits and without
//      any `--launched-by-task` flag — so the scenario-B special-case
//      doesn't catch it, and the child dies silently. User sees
//      nothing reopen.
//
// Original v0.4.1 only special-cased `--launched-by-task` for the
// retry loop, which broke scenario C. The correct fix is to always
// retry briefly on Windows — any user-initiated duplicate can tolerate
// a 3 s "wait for predecessor to quit" before giving up and focusing
// the existing window. Non-Windows platforms keep the strict behaviour.
const SECOND_INSTANCE_FOCUS_EVENT = "second-instance";
const singleInstanceLaunchedByTask = process.argv.includes("--launched-by-task");
const singleInstanceRelaunchedAsAdmin = process.argv.includes("--relaunched-as-admin");
const WINDOWS_LOCK_RETRY_MS = 5_000; // 20 × 250 ms polls
const NORMAL_LOCK_RETRY_MS = 1_500; //  6 × 250 ms polls — covers brief races without blocking duplicate-launch UX

function registerSecondInstanceHandler(): void {
  app.on(SECOND_INSTANCE_FOCUS_EVENT, () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    if (!mainWindow.isVisible()) mainWindow.show();
    mainWindow.focus();
  });
}

async function acquireSingleInstanceLockOrExit(): Promise<void> {
  if (app.requestSingleInstanceLock()) {
    registerSecondInstanceHandler();
    return;
  }

  // Lock is held. How long are we willing to wait for it?
  //   - Launched by the scheduled task or a relaunch-as-admin handoff:
  //     5 s (parent is deliberately quitting, we WILL succeed).
  //   - Any other Windows launch: 1.5 s — enough to survive a quick
  //     double-click race without making duplicate-launch feel slow.
  //   - Non-Windows: no retry, exit immediately.
  const maxWaitMs =
    process.platform !== "win32"
      ? 0
      : singleInstanceLaunchedByTask || singleInstanceRelaunchedAsAdmin
        ? WINDOWS_LOCK_RETRY_MS
        : NORMAL_LOCK_RETRY_MS;

  const polls = Math.floor(maxWaitMs / 250);
  for (let i = 0; i < polls; i++) {
    await new Promise((r) => setTimeout(r, 250));
    if (app.requestSingleInstanceLock()) {
      writeStartupLog(
        `single-instance lock acquired after ${(i + 1) * 250} ms retry (launchedByTask=${singleInstanceLaunchedByTask}, relaunchedAsAdmin=${singleInstanceRelaunchedAsAdmin})`,
      );
      registerSecondInstanceHandler();
      return;
    }
  }

  // Still held — assume a genuinely-concurrent instance. Electron has
  // already signalled the primary with `second-instance`; our job is
  // just to exit cleanly.
  writeStartupLog(
    `single-instance lock not acquired after ${maxWaitMs} ms — another DiskHound is already running (launchedByTask=${singleInstanceLaunchedByTask}, relaunchedAsAdmin=${singleInstanceRelaunchedAsAdmin}), exiting`,
  );
  app.quit();
  process.exit(0);
}

void app.whenReady().then(async () => {
  writeStartupLog("whenReady fired");
  await acquireSingleInstanceLockOrExit();
  if (process.platform === "win32") {
    app.setAppUserModelId("com.diskhound.app");
  }

  if (process.platform === "linux") {
    // First-run (and every-run, idempotently) XDG desktop integration:
    // drop the .desktop file into ~/.local/share/applications and the
    // hicolor icons into ~/.local/share/icons/hicolor so GNOME's dock
    // can match the running window to a proper launcher entry. Without
    // this, AppImage users saw a blank/generic icon in the sidebar
    // because the .desktop file embedded *inside* the AppImage isn't
    // on the XDG search path. Runs in parallel with the rest of
    // startup — the window doesn't block on it.
    const { integrateLinuxDesktop } = await import("./linuxDesktopIntegration");
    const os = await import("node:os");
    void integrateLinuxDesktop({
      homeDir: os.homedir(),
      iconsDir: resolveIconsDir(),
      // APPIMAGE is the env var set by the AppImage runtime and points
      // at the .AppImage file the user double-clicked. process.execPath
      // inside an AppImage resolves to /tmp/.mount_XXXXX/... which
      // vanishes the moment the AppImage unmounts — useless as an
      // Exec= target. Outside AppImage (tar.gz extract, dev run) fall
      // back to the real binary path.
      execPath: process.env.APPIMAGE || process.execPath,
      logger: writeCrashLog,
    }).catch((err) => {
      writeCrashLog(
        "linux-integration",
        `top-level await rejected: ${err instanceof Error ? err.message : String(err)}`,
      );
    });
  }

  if (process.platform === "win32") {
    // Auto-relaunch via the registered Scheduled Task (if any). This
    // is what makes "Always run as admin" actually always: normal
    // shortcut click → this non-elevated instance detects the task,
    // fires it, quits. The task launches a new elevated instance
    // with NO UAC prompt because Windows honors the saved HighestAvailable
    // RunLevel credential. Guarded by process.argv to avoid a loop
    // (the elevated task invocation passes `--launched-by-task` so we
    // know not to relaunch AGAIN).
    const launchedByTask = process.argv.includes("--launched-by-task");
    const relaunchedAsAdmin = process.argv.includes("--relaunched-as-admin");
    writeStartupLog(
      `elevation-probe: argv flags launchedByTask=${launchedByTask} relaunchedAsAdmin=${relaunchedAsAdmin} pid=${process.pid}`,
    );
    if (!launchedByTask) {
      try {
        const [elevated, taskRegistered] = await Promise.all([
          elevationModule.isElevated(),
          elevationModule.hasScheduledTask(),
        ]);
        writeStartupLog(
          `elevation-probe: isElevated=${elevated} hasScheduledTask=${taskRegistered}`,
        );
        if (!elevated && taskRegistered) {
          writeStartupLog("auto-relaunch via scheduled task (not elevated, task registered)");
          // Always re-register the task on startup before we run it.
          // This catches the "reinstalled to a new path" failure mode
          // where the registered task points at a stale exe location.
          // Re-registering requires UAC. Since the user is being
          // prompted anyway (first run after install), we skip the
          // silent re-register here and just run the existing task;
          // if that fails with "cannot find file" we'll surface the
          // error in the Settings UI where the user can re-register.
          const result = await elevationModule.runScheduledTaskNow();
          writeStartupLog(
            `scheduled-task run result: ok=${result.ok} exitCode=${result.exitCode ?? "?"} stdout=${JSON.stringify(result.stdout ?? "")} stderr=${JSON.stringify(result.stderr ?? "")}`,
          );
          if (result.ok) {
            // Wait briefly, then verify a second DiskHound.exe actually
            // spun up before we quit. If the task failed to elevate
            // (e.g. user account can't elevate, task credential stale)
            // the elevated instance never starts and quitting here
            // leaves the user with no app at all. Revert to normal
            // startup if we can't confirm the relaunch.
            await new Promise((r) => setTimeout(r, 2500));
            const elevatedInstanceRunning = await elevationModule
              .countDiskHoundProcesses()
              .catch(() => 0);
            if (elevatedInstanceRunning > 1) {
              writeStartupLog(
                `elevated sibling detected (${elevatedInstanceRunning} DiskHound.exe processes) — quitting this non-elevated instance`,
              );
              app.quit();
              return;
            }
            writeStartupLog(
              `scheduled task triggered but no elevated sibling appeared after 2.5s (found=${elevatedInstanceRunning}) — continuing non-elevated`,
            );
          } else {
            writeStartupLog(
              `scheduled task run failed: ${result.message ?? "unknown error"} (exit=${result.exitCode ?? "?"}) — continuing non-elevated`,
            );
          }
        }
      } catch (err) {
        writeStartupLog(
          `scheduled-task auto-relaunch probe failed: ${err instanceof Error ? err.message : String(err)}`,
        );
        // Non-fatal — fall through to normal non-elevated startup.
      }
    }
  }

  const scanStore = await createScanSnapshotStore(app.getPath("userData"));
  settingsStore = await createSettingsStore();
  // Window-geometry persistence — restores width/height/x/y plus
  // maximize / fullscreen state across restarts. Must be created
  // before createWindow() so resolveBounds() can feed the
  // BrowserWindow constructor.
  windowStateStore = await createWindowStateStore({
    defaults: { width: 1560, height: 980 },
    minWidth: 960,
    minHeight: 640,
  });

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
  // Wire crash-log hook so EasyMove can trace its decision path.
  // Without this the "EasyMove failed with EPERM" diagnostic is a
  // black box — we can't tell which tier (rename / copy / robocopy)
  // actually failed or whether isElevated returned as expected.
  setEasyMoveLogger((tag, msg) => writeCrashLog(tag, msg));

  // Wire progress-broadcast hook. Stream-copy fires this every
  // ~500 ms during long cross-drive moves; the renderer subscribes
  // via onEasyMoveProgress and shows a live progress toast.
  setEasyMoveProgress((progress) => {
    mainWindow?.webContents.send("diskhound:easy-move-progress", progress);
  });

  // Initialize scan history + full-file indexes
  initScanHistory(app.getPath("userData"));
  initScanIndex(app.getPath("userData"));
  initFullDiffCacheStore(app.getPath("userData"));
  await initUsnCursorStore(app.getPath("userData"));

  const treemapCache = createTreemapCache({ maxEntries: 6 });

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

        // Rename the temp folder-tree sidecar to match the history ID
        // so the Folders-tab loader can find it by scanId. Done first
        // because it's cheap and independent of the NDJSON rename —
        // if this fails the legacy streaming fallback still works.
        if (historyId && session.tempFolderTreePath) {
          try {
            await FS.rename(
              session.tempFolderTreePath,
              folderTreeSidecarPath(historyId),
            );
          } catch {
            // Sidecar didn't land (scanner skipped it, write failed,
            // etc.). The legacy streaming worker path will handle the
            // Folders tab — slower but correct.
          }
        }

        // Rename the temp index file to match the history entry ID
        if (historyId && session.tempIndexPath) {
          try {
            await FS.rename(session.tempIndexPath, indexFilePath(historyId));
            if (message.snapshot.rootPath) {
              treemapCache.rememberLatest(message.snapshot.rootPath, historyId);
            }
            // Evict the prior folder tree for this same root BEFORE
            // kicking off the new build — keeping both in memory
            // doubles peak heap during every rescan cycle.
            if (message.snapshot.rootPath) {
              invalidateFolderTreesForRoot(message.snapshot.rootPath, historyId);
            }
            // Pre-warm the Folders-tab tree, but DEFER it by a few
            // seconds. Scan-complete leaves the main process with a
            // large residue of transient allocations (snapshot history
            // writes, progress-message arrays); kicking off another
            // 500-800 MB allocation for the new tree immediately can
            // push heapTotal past V8's ceiling before GC catches up —
            // observed as a silent hard-abort on a 7.27 M-file C:\
            // scan. A 3-second gap gives V8 time for a major GC cycle
            // before we rebuild the tree.
            const prewarmHistoryId = historyId;
            const prewarmRootPath = message.snapshot.rootPath ?? undefined;
            setTimeout(() => {
              void ensureFolderTree(prewarmHistoryId, prewarmRootPath, {
                skipIfMemoryPressureMb: PREWARM_RSS_CEILING_MB,
              }).catch((err) => {
                writeCrashLog(
                  "folder-tree-prewarm",
                  err instanceof Error ? (err.stack ?? err.message) : String(err),
                );
              });
            }, 3000);
          } catch {
            // Scanner may have skipped or failed to write the index — ignore
          }
        }

        // Delete index files for any history entries that just got pruned
        for (const prunedId of consumeLastPrunedIds()) {
          treemapCache.invalidateScan(prunedId);
          invalidateFolderTree(prunedId);
          void deleteFolderTreeSidecar(prunedId);
          void deleteIndex(prunedId);
          void deleteFullDiffCachesForScan(prunedId);
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
        retuneMemoryDiagCadence();
        markFullScan();
        // Snapshot memory right after a scan settles so users can
        // correlate "I scanned C:\ and now DiskHound is using 800 MB"
        // with an actual line in crash.log.
        writeCrashLog(
          "memory",
          `post-scan ${message.snapshot.rootPath ?? "?"} files=${message.snapshot.filesVisited}: ${describeCacheMemory()}`,
        );
        if (message.snapshot.rootPath) {
          warmLatestFullDiff(message.snapshot.rootPath);
        }

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
          // Include the actual root so users running parallel scans on
          // multiple drives can tell which one just finished — the old
          // copy said "Found N files" with no drive attribution, which
          // was ambiguous when three toast arrived in quick succession.
          const rootLabel = message.snapshot.rootPath ?? "scan root";
          sendToast(
            "success",
            `Scan complete — ${rootLabel}`,
            `${message.snapshot.filesVisited.toLocaleString()} files · ${formatBytesShort(message.snapshot.bytesSeen)} total.`,
          );

          if (Notification.isSupported()) {
            new Notification({
              title: `DiskHound — Scan complete: ${rootLabel}`,
              body: `${message.snapshot.filesVisited.toLocaleString()} files · ${formatBytesShort(message.snapshot.bytesSeen)}.`,
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
    retuneMemoryDiagCadence();
    // Clean up orphaned temp index file
    if (session.tempIndexPath) {
      try { await FS.unlink(session.tempIndexPath); } catch { /* already gone */ }
    }
    if (session.tempFolderTreePath) {
      try { await FS.unlink(session.tempFolderTreePath); } catch { /* already gone */ }
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
    const pendingScanId = `pending-${randomUUID()}`;
    const tempIndexPath = indexFilePath(pendingScanId);
    // Sidecar's temp path shares the pending UUID so we can rename
    // both atomically on scan-complete to match the final history ID.
    const tempFolderTreePath = folderTreeSidecarPath(pendingScanId);
    const baselineIndex = resolveBaselineIndexFor(rootPath);

    // Buffer for messages that arrive before the session is fully wired
    const earlyMessages: WorkerToMainMessage[] = [];
    let earlyErrors: Error[] = [];
    let sessionRef: ActiveScanSession | null = null;

    const nativeResult = createNativeScannerSession(
      projectRoot,
      {
        rootPath,
        options: scanOptions,
        indexOutput: tempIndexPath,
        baselineIndex,
        folderTreeOutput: tempFolderTreePath,
      },
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
        // Forward native scanner diagnostic lines (phase timings,
        // inheritance stats, etc.) to crash.log so users can share them
        // when asking "why is my scan slow?" without needing to attach
        // a debugger or run from a terminal.
        onStderrLine: (line) => {
          if (line.includes("[diskhound-native-scanner]")) {
            writeCrashLog("scanner", line);
          }
          // Self-healing baseline rejection — surface a toast so the
          // user understands why an incremental scan just decided to
          // do a full walk. Without this the scan "feels slow again"
          // with no explanation; the toast makes it clear this is a
          // one-time recovery event and next scan will be fast again.
          if (line.includes("baseline REJECTED as truncated")) {
            sendToast(
              "info",
              "Rebuilding scan index",
              "Previous index was incomplete — running a full walk once to rebuild it. Future rescans will be fast again.",
            );
          }
        },
      },
    );

    if (nativeResult) {
      // Wire up the session with active=true BEFORE flushing buffered messages
      sessionRef = Object.assign(nativeResult, {
        active: true,
        trigger,
        tempIndexPath,
        tempFolderTreePath,
        rootPath,
      }) as ActiveScanSession;

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
    if (session.tempFolderTreePath) {
      try { await FS.unlink(session.tempFolderTreePath); } catch { /* already gone */ }
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

    // USN-journal fast-path: if a cursor was captured after a prior
    // scan of this volume AND the journal records no changes since
    // then, reuse the last snapshot entirely. Typical latency ~100 ms
    // on NTFS (vs ~60 s for a full MFT scan). Falls through to the
    // regular scan if:
    //   - no cursor persisted (first scan of this volume)
    //   - journal was recreated (journalId mismatch)
    //   - scanner binary spawn fails (non-NTFS, missing elevation,
    //     or the rare case where the volume's journal is disabled)
    //   - any record has been written to the journal since the cursor
    const scannerBinary = resolveNativeScannerBinary(projectRoot);
    if (scannerBinary && trigger !== "scheduled") {
      try {
        const probe = await checkUsnForAnyChanges(scannerBinary, rootPath);
        if (probe && !probe.changed) {
          const latest = await nativeApi_getLatestSnapshotForRoot_impl(rootPath);
          if (latest) {
            writeCrashLog(
              "usn-fast-path",
              `${rootPath}: no journal changes since last scan — reusing snapshot (files=${latest.filesVisited}, bytes=${latest.bytesSeen})`,
            );
            // Update the cursor to the probe's new cursor so the NEXT
            // rescan's fast-path-vs-full decision compares against the
            // moment of THIS rescan, not the original scan.
            if (
              typeof probe.newCursor === "number"
              && typeof probe.newJournalId === "number"
            ) {
              const volume = volumeForPath(rootPath);
              if (volume) {
                await setCursor({
                  volume,
                  cursor: probe.newCursor,
                  journalId: probe.newJournalId,
                  capturedAt: Date.now(),
                  rootPath,
                });
              }
            }
            // Synthesize a Done snapshot reusing last scan's data,
            // stamped with fresh timestamps so the UI's "last scanned
            // X ago" counter resets. Don't create a new history entry
            // — nothing changed, so the existing one still represents
            // the drive's current state.
            const now = Date.now();
            const fastPathSnapshot: ScanSnapshot = {
              ...latest,
              status: "done",
              startedAt: now,
              finishedAt: now,
              elapsedMs: 1,
              lastUpdatedAt: now,
              scanPhase: "complete",
            };
            await broadcastSnapshot(fastPathSnapshot);
            return fastPathSnapshot;
          }
        }
      } catch (err) {
        // Any fast-path failure is non-fatal; fall through to full
        // scan. The log line helps us distinguish cursor-invalid
        // cases from plain "no prior scan" ones when diagnosing.
        writeCrashLog(
          "usn-fast-path-error",
          err instanceof Error ? (err.stack ?? err.message) : String(err),
        );
      }
    }

    const { session, startingSnapshot } = createPreferredScanSession(
      rootPath,
      resolvedScanOptions,
      trigger,
    );
    activeScans.set(scanKey(rootPath), session);
    retuneMemoryDiagCadence();
    await broadcastSnapshot(startingSnapshot);
    return startingSnapshot;
  };

  // Inline helper that mirrors the "get latest snapshot for root" IPC
  // handler below — used by the fast-path branch above to load the
  // last scan's data when we decide nothing has changed.
  const nativeApi_getLatestSnapshotForRoot_impl = async (
    rootPath: string,
  ): Promise<ScanSnapshot | null> => {
    const history = getScanHistory(rootPath);
    const latest = history[0];
    if (!latest) return null;
    return await loadHistoricalSnapshot(latest.id);
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

  // Elevation + fast-scan admin UX. Renderer reads `isElevated` on
  // boot to decide whether to show the "Run as admin for faster
  // scans" banner; Settings → Performance calls `relaunchAsAdmin`
  // directly. `hasScheduledTask` tells the UI whether the
  // "always elevated" opt-in was already taken so it can suppress
  // the banner after the user has committed.
  ipcMain.handle("diskhound:get-elevation-status", async () => {
    const [elevated, taskRegistered] = await Promise.all([
      elevationModule.isElevated(),
      elevationModule.hasScheduledTask(),
    ]);
    return { elevated, scheduledTaskRegistered: taskRegistered };
  });
  ipcMain.handle("diskhound:relaunch-as-admin", async () => {
    try {
      const launched = await elevationModule.relaunchAsAdmin(app.getPath("exe"));
      if (launched) {
        // Only quit if UAC was accepted + the new elevated instance
        // actually started. On UAC cancel, keep the current window
        // alive so the user isn't left with a closed app. Give the
        // new instance a brief moment to reserve its window focus
        // before we exit the old one.
        setTimeout(() => app.quit(), 500);
        return { ok: true };
      }
      return {
        ok: false,
        message: "UAC was cancelled or no elevated process was started. Still running non-elevated.",
      };
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : String(err) };
    }
  });
  ipcMain.handle("diskhound:register-scheduled-task", async () => {
    const ok = await elevationModule.registerScheduledTask(app.getPath("exe"));
    return { ok };
  });
  ipcMain.handle("diskhound:unregister-scheduled-task", async () => {
    const ok = await elevationModule.unregisterScheduledTask();
    return { ok };
  });
  ipcMain.handle("diskhound:run-scheduled-task", async () => {
    const result = await elevationModule.runScheduledTaskNow();
    if (result.ok) {
      // Give the elevated task a moment to come up before we quit,
      // so the user sees the new (elevated) window in the same visual
      // gesture as closing this non-elevated one.
      setTimeout(() => app.quit(), 500);
    } else {
      writeCrashLog(
        "run-scheduled-task",
        `schtasks /run failed: exit=${result.exitCode ?? "?"} stderr=${result.stderr ?? ""} stdout=${result.stdout ?? ""}`,
      );
    }
    return { ok: result.ok, message: result.message };
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
  // Same pattern for GPU sampling. Get-Counter is the slow one — we
  // dedupe concurrent refreshes and cache between them so the UI tab
  // switch is instant.
  let gpuCache: import("./shared/contracts").GpuSnapshot | null = null;
  let gpuSamplePromise: Promise<import("./shared/contracts").GpuSnapshot> | null = null;
  // Throttle affinity-rule enforcement to one pass per 4 s regardless
  // of how often the memory sample refreshes. Affinity reads + writes
  // shell out to PowerShell, which isn't free; 4 s is fast enough to
  // catch a newly-launched process within a few ticks yet slow enough
  // that the shell overhead stays a rounding error of the system load.
  const AFFINITY_ENFORCE_INTERVAL_MS = 4000;
  let lastAffinityEnforcementAt = 0;
  let affinityEnforcementInFlight = false;

  const refreshMemorySample = (): Promise<SystemMemorySnapshot> => {
    if (memorySamplePromise) return memorySamplePromise;
    memorySamplePromise = sampleSystemMemory()
      .then((snap) => {
        memoryCache = snap;
        memorySamplePromise = null;
        // Fire-and-forget: enforce affinity rules against the fresh
        // process sample. Throttled internally — spawning the
        // enforcement pass here is cheap because it returns
        // immediately when not due.
        void maybeEnforceAffinityRules(snap).catch(() => { /* non-fatal */ });
        return snap;
      })
      .catch((err) => {
        memorySamplePromise = null;
        throw err;
      });
    return memorySamplePromise;
  };

  const maybeEnforceAffinityRules = async (snap: SystemMemorySnapshot) => {
    if (process.platform !== "win32") return;
    if (affinityEnforcementInFlight) return;
    const now = Date.now();
    if (now - lastAffinityEnforcementAt < AFFINITY_ENFORCE_INTERVAL_MS) return;
    const settings = settingsStore?.get();
    if (!settings || settings.affinityRules.length === 0) return;

    affinityEnforcementInFlight = true;
    try {
      const { enforceAffinityRules } = await import("./affinityRuleEngine");
      const results = await enforceAffinityRules(settings.affinityRules, snap.processes);
      lastAffinityEnforcementAt = Date.now();
      if (results.length === 0) return;

      // Persist the updated counters. We only update rules that were
      // actually applied this tick; unchanged rules keep their prior
      // values. Rule order preserved via index lookup.
      const byId = new Map<string, typeof results[number]>();
      for (const r of results) byId.set(r.ruleId, r);
      const nowMs = Date.now();
      const nextRules = settings.affinityRules.map((rule) => {
        const hit = byId.get(rule.id);
        if (!hit || !hit.ok) return rule;
        return {
          ...rule,
          lastAppliedAt: nowMs,
          appliedCount: rule.appliedCount + 1,
        };
      });
      await settingsStore?.set({ ...settings, affinityRules: nextRules });
      for (const r of results) {
        if (r.ok) {
          writeCrashLog(
            "affinity-rule-applied",
            `rule=${r.ruleId} pid=${r.pid} name=${r.processName} prevMask=${r.previousMask} newMask=${r.newMask}`,
          );
        } else if (r.error) {
          writeCrashLog(
            "affinity-rule-error",
            `rule=${r.ruleId} pid=${r.pid} name=${r.processName}: ${r.error}`,
          );
        }
      }
    } finally {
      affinityEnforcementInFlight = false;
    }
  };

  ipcMain.handle("diskhound:get-memory-snapshot", () => refreshMemorySample());

  // Instant cached read — returns null if nothing sampled yet. The renderer
  // uses this on mount to paint the list immediately, then kicks off a
  // real refresh in the background.
  ipcMain.handle("diskhound:get-cached-memory-snapshot", () => {
    if (!memoryCache) return null;
    return { ...memoryCache, isStale: true };
  });

  // GPU sample — separate cadence from memory so the GPU tab can be
  // opened/closed without forcing a memory resample, and vice versa.
  // The sampler's PowerShell invocation is expensive (~500-1500 ms on
  // cold start), so deduping concurrent requests matters.
  const refreshGpuSample = async () => {
    if (gpuSamplePromise) return gpuSamplePromise;
    const { sampleGpu } = await import("./shared/gpuSampler");
    gpuSamplePromise = sampleGpu()
      .then((snap) => {
        gpuCache = snap;
        return snap;
      })
      .finally(() => {
        gpuSamplePromise = null;
      });
    return gpuSamplePromise;
  };
  ipcMain.handle("diskhound:get-gpu-snapshot", () => refreshGpuSample());
  ipcMain.handle("diskhound:get-cached-gpu-snapshot", () => {
    if (!gpuCache) return null;
    return gpuCache;
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

  // ── CPU affinity ───────────────────────────────────────────
  //
  // Get and set the CPU affinity mask for a process. Uses Windows'
  // Win32 API via PowerShell: `Get-Process -Id $pid | Select
  // -ExpandProperty ProcessorAffinity` for read, and assignment to
  // the same property for write. We report the system's logical
  // processor count alongside so the UI can render the correct
  // number of checkboxes.
  //
  // Requires admin if the target process was started by a different
  // user (or is a protected process). For user's own processes on
  // their own account, no elevation needed.
  ipcMain.handle("diskhound:get-cpu-affinity", async (_event, pid: number): Promise<{
    ok: boolean;
    affinityMask?: number;
    cpuCount: number;
    message?: string;
  }> => {
    const cpuCount = require("node:os").cpus().length;
    if (process.platform !== "win32") {
      return { ok: false, cpuCount, message: "CPU affinity is Windows-only" };
    }
    try {
      const { spawn } = require("node:child_process");
      const result = await new Promise<string>((resolve, reject) => {
        const child = spawn(
          "powershell.exe",
          [
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            `(Get-Process -Id ${pid} -ErrorAction Stop).ProcessorAffinity.ToInt64()`,
          ],
          { stdio: ["ignore", "pipe", "pipe"], windowsHide: true },
        );
        let stdoutBuf = "";
        let stderrBuf = "";
        child.stdout?.on("data", (c: Buffer) => { stdoutBuf += String(c); });
        child.stderr?.on("data", (c: Buffer) => { stderrBuf += String(c); });
        child.on("exit", (code: number | null) => {
          if (code === 0) resolve(stdoutBuf.trim());
          else reject(new Error(stderrBuf.trim() || `exit ${code}`));
        });
      });
      const mask = Number(result);
      if (!Number.isFinite(mask)) {
        return { ok: false, cpuCount, message: `Couldn't parse affinity mask: ${result}` };
      }
      return { ok: true, affinityMask: mask, cpuCount };
    } catch (err) {
      return {
        ok: false,
        cpuCount,
        message: err instanceof Error ? err.message : String(err),
      };
    }
  });

  // ── Persistent affinity rules ───────────────────────────────
  //
  // Rules live in AppSettings so they persist across restarts.
  // Read/write goes through settingsStore — the same normalization
  // pass that validates `general.theme` / `monitoring.*` also strips
  // malformed rule entries, so we never crash on a tampered file.
  ipcMain.handle("diskhound:get-affinity-rules", () => {
    const settings = settingsStore?.get();
    return settings?.affinityRules ?? [];
  });
  ipcMain.handle("diskhound:upsert-affinity-rule", async (_event, rule: AffinityRule) => {
    const settings = settingsStore?.get();
    if (!settings) return { ok: false, message: "Settings unavailable" };
    const next = settings.affinityRules.slice();
    const idx = next.findIndex((r) => r.id === rule.id);
    if (idx >= 0) next[idx] = rule;
    else next.push(rule);
    await settingsStore?.set({ ...settings, affinityRules: next });
    return { ok: true };
  });
  ipcMain.handle("diskhound:delete-affinity-rule", async (_event, id: string) => {
    const settings = settingsStore?.get();
    if (!settings) return { ok: false, message: "Settings unavailable" };
    const next = settings.affinityRules.filter((r) => r.id !== id);
    await settingsStore?.set({ ...settings, affinityRules: next });
    return { ok: true };
  });

  ipcMain.handle("diskhound:set-cpu-affinity", async (_event, pid: number, mask: number): Promise<PathActionResult> => {
    if (process.platform !== "win32") {
      return { ok: false, message: "CPU affinity is Windows-only" };
    }
    if (!Number.isInteger(mask) || mask <= 0) {
      return { ok: false, message: "Affinity mask must be a positive integer" };
    }
    try {
      const { spawn } = require("node:child_process");
      await new Promise<void>((resolve, reject) => {
        const child = spawn(
          "powershell.exe",
          [
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            // Assigning IntPtr-typed ProcessorAffinity from an int
            // requires explicit cast. `[IntPtr]${mask}` is how
            // PowerShell constructs a pointer-sized int for the
            // setter call.
            `$p = Get-Process -Id ${pid} -ErrorAction Stop; $p.ProcessorAffinity = [IntPtr]${mask}`,
          ],
          { stdio: ["ignore", "ignore", "pipe"], windowsHide: true },
        );
        let stderrBuf = "";
        child.stderr?.on("data", (c: Buffer) => { stderrBuf += String(c); });
        child.on("exit", (code: number | null) => {
          if (code === 0) resolve();
          else reject(new Error(stderrBuf.trim() || `exit ${code}`));
        });
      });
      return { ok: true, message: `Affinity set on PID ${pid}` };
    } catch (err) {
      return {
        ok: false,
        message: err instanceof Error ? err.message : String(err),
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

  // ── IPC: Crash logs ───────────────────────────────────────
  //
  // Read-only helpers for the Settings "View crash logs" UI. The log
  // itself is written by the writeCrashLog() helper declared up top.

  ipcMain.handle("diskhound:get-crash-log", async () => {
    const path = crashLogPath();
    try {
      const stat = await FS.stat(path);
      const text = await FS.readFile(path, "utf-8");
      // Ship the TAIL — users don't need to scroll through 1 MB of
      // boot diagnostics when triaging a recent crash. 64 KB tail
      // covers weeks of typical logging and is easy to paste.
      const TAIL_BYTES = 64 * 1024;
      const trimmed = text.length > TAIL_BYTES
        ? "[…earlier entries truncated…]\n" + text.slice(text.length - TAIL_BYTES)
        : text;
      return { path, sizeBytes: stat.size, text: trimmed };
    } catch {
      return { path, sizeBytes: 0, text: "" };
    }
  });

  // Fire-and-forget — preload uses `ipcRenderer.send` because there's
  // nothing to await here. `showItemInFolder` opens the user's OS
  // file browser, highlighting crash.log alongside its rotated
  // crash.log.old sibling.
  ipcMain.on("diskhound:reveal-crash-log", () => {
    shell.showItemInFolder(crashLogPath());
  });

  // Renderer errors get forwarded here via window.onerror / onunhandled-
  // rejection, so uncaught rendering bugs also land in the same file.
  ipcMain.on("diskhound:report-renderer-error", (_event, payload: {
    message: string;
    stack?: string;
    source?: string;
  }) => {
    const loc = payload.source ? ` @ ${payload.source}` : "";
    writeCrashLog("renderer", `${payload.message}${loc}\n${payload.stack ?? ""}`);
  });

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

  /**
   * Elevated EasyMove: for files the user can't stat/move as a normal
   * user (Windows-protected paths). The renderer shows a confirm
   * dialog then calls this; we spawn a single UAC-elevated PowerShell
   * that does the move + link creation, then record the move in the
   * store. One UAC prompt per invocation.
   */
  ipcMain.handle(
    "diskhound:easy-move-elevated",
    async (_event, sourcePath: string, destinationDir: string) => {
      const baseName = Path.basename(sourcePath);
      const destinationPath = Path.join(destinationDir, baseName);

      // Probe the source to decide file vs dir — lstat works even on
      // Windows-protected paths for directory detection via the mode
      // bits. Fall back to a filename heuristic if lstat itself fails.
      let isDirectory = false;
      try {
        const stat = await FS.lstat(sourcePath);
        isDirectory = stat.isDirectory();
      } catch {
        // Heuristic: treat as file if it has an extension, dir otherwise.
        isDirectory = !/\.[^\\/]+$/.test(baseName);
      }

      // Destination already present? Abort — overwriting via an
      // elevated move is a footgun. Surface a clear message.
      if (FS_SYNC.existsSync(destinationPath)) {
        return {
          ok: false,
          message: `Destination already exists: ${destinationPath}`,
        };
      }

      // Ensure destination directory exists (non-elevated mkdir is fine
      // as long as the destination is user-writeable, which it must be
      // for the user to have chosen it).
      try {
        await FS.mkdir(destinationDir, { recursive: true });
      } catch {
        /* best effort — elevated PS will fail cleanly if dir is bad */
      }

      const res = await elevationModule.runElevatedEasyMove(
        sourcePath,
        destinationPath,
        isDirectory,
      );
      if (!res.ok) {
        return {
          ok: false,
          message: res.cancelled
            ? "Cancelled — move not performed."
            : `Elevated move failed: ${res.message ?? "unknown error"}`,
        };
      }

      // Stat the destination to record the size. We stat the DESTINATION
      // because the source is now a symlink/junction; stat'ing it would
      // de-reference and return the dest's stats anyway, but being
      // explicit avoids a circular surprise on non-deref'ing platforms.
      let size = 0;
      try {
        const stat = await FS.stat(destinationPath);
        size = stat.size;
      } catch {
        /* size=0 is harmless; UI uses size for the Easy Move list metric only */
      }

      const { recordElevatedEasyMove } = await import("./shared/easyMoveStore");
      return recordElevatedEasyMove({
        sourcePath,
        destinationPath,
        size,
        isDirectory,
      });
    },
  );

  ipcMain.handle("diskhound:easy-move-back", async (_event, recordId: string) => {
    return easyMoveBack(recordId);
  });

  ipcMain.handle("diskhound:get-easy-moves", () => getEasyMoves());
  ipcMain.handle("diskhound:verify-easy-moves", () => verifyEasyMoves());

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
  const fullDiffCache = new Map<string, FullDiffResult | null>();
  const fullDiffInflight = new Map<string, Promise<FullDiffResult | null>>();
  const FULL_DIFF_CACHE_LIMIT = 8;
  const readFullDiffMemoryCache = (key: string) => {
    const cached = fullDiffCache.get(key);
    if (cached !== undefined) {
      fullDiffCache.delete(key);
      fullDiffCache.set(key, cached);
      return cached;
    }
    return undefined;
  };
  const writeFullDiffMemoryCache = (key: string, value: FullDiffResult | null) => {
    fullDiffCache.delete(key);
    fullDiffCache.set(key, value);
    while (fullDiffCache.size > FULL_DIFF_CACHE_LIMIT) {
      const oldest = fullDiffCache.keys().next().value;
      if (oldest) fullDiffCache.delete(oldest);
      else break;
    }
  };
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
  const normalizeDiffLimit = (limit?: number) =>
    typeof limit === "number" && Number.isFinite(limit)
      ? Math.max(0, Math.floor(limit))
      : 500;
  const buildFullDiffCacheKey = (baselineId: string, currentId: string, limit: number) =>
    `${baselineId}::${currentId}::${limit}`;
  const getIndexBytes = async (id: string): Promise<number | null> => {
    try {
      const stat = await FS.stat(indexFilePath(id));
      return stat.isFile() ? stat.size : null;
    } catch {
      return null;
    }
  };
  const loadOrComputeFullDiff = async (
    baselineId: string,
    currentId: string,
    limit?: number,
  ): Promise<FullDiffResult | null> => {
    const normalizedLimit = normalizeDiffLimit(limit);
    const cacheKey = buildFullDiffCacheKey(baselineId, currentId, normalizedLimit);
    const memoryCached = readFullDiffMemoryCache(cacheKey);
    if (memoryCached !== undefined) {
      return memoryCached;
    }

    const existing = fullDiffInflight.get(cacheKey);
    if (existing) {
      return existing;
    }

    const pending = (async () => {
      const diskCached = await readFullDiffCache(baselineId, currentId, normalizedLimit);
      if (diskCached !== null) {
        writeFullDiffMemoryCache(cacheKey, diskCached);
        return diskCached;
      }

      // Fast path: if the snapshot aggregates match exactly (bytes,
      // files, dirs), the per-file diff is guaranteed empty. Short-
      // circuit so we don't spawn the 4 GB worker just to prove that
      // — on a 7.27M-file C:\ scan the worker otherwise OOMs even
      // when nothing changed (building two full path→size maps to
      // compare them is what costs the heap, not emitting deltas).
      const [baseSnap, currSnap] = await Promise.all([
        loadHistoricalSnapshotCached(baselineId),
        loadHistoricalSnapshotCached(currentId),
      ]);
      if (
        baseSnap && currSnap &&
        baseSnap.bytesSeen === currSnap.bytesSeen &&
        baseSnap.filesVisited === currSnap.filesVisited &&
        baseSnap.directoriesVisited === currSnap.directoriesVisited
      ) {
        const emptyResult: FullDiffResult = {
          baselineId,
          currentId,
          totalChanges: 0,
          totalAdded: 0,
          totalRemoved: 0,
          totalGrew: 0,
          totalShrank: 0,
          totalBytesAdded: 0,
          totalBytesRemoved: 0,
          changes: [],
          truncated: false,
        };
        writeFullDiffMemoryCache(cacheKey, emptyResult);
        await writeFullDiffCache(emptyResult, normalizedLimit);
        return emptyResult;
      }

      const input = {
        baselineId,
        currentId,
        baselinePath: indexFilePath(baselineId),
        currentPath: indexFilePath(currentId),
        limit: normalizedLimit,
      };

      let result: FullDiffResult | null = null;
      try {
        result = await runFullDiffWorker(input, { workerPath: fullDiffWorkerEntry });
      } catch (err) {
        writeCrashLog("full-diff-worker", err instanceof Error ? (err.stack ?? err.message) : String(err));
        // Fallback: run inline on the main thread. Still slow for big
        // indexes but at least produces a result rather than leaving
        // the user stuck on "preparing…" forever.
        try {
          result = await computeFullDiffFromIndexFiles(input);
        } catch (fallbackErr) {
          writeCrashLog(
            "full-diff-inline",
            fallbackErr instanceof Error ? (fallbackErr.stack ?? fallbackErr.message) : String(fallbackErr),
          );
          result = null;
        }
      }

      // Only cache POSITIVE results. A null result typically means one of
      // the index files is missing or unreadable — caching that as null
      // would let a transient condition (file still being written, brief
      // permission hiccup) poison the cache and surface as the permanent
      // "Load full file diff" CTA loop the user reported.
      if (result) {
        writeFullDiffMemoryCache(cacheKey, result);
        await writeFullDiffCache(result, normalizedLimit);
      }
      return result;
    })().finally(() => {
      fullDiffInflight.delete(cacheKey);
    });

    fullDiffInflight.set(cacheKey, pending);
    return pending;
  };
  const warmLatestFullDiff = (rootPath: string) => {
    const latestPair = getLatestPair(rootPath);
    if (!latestPair) return;
    void loadOrComputeFullDiff(latestPair.baseline.id, latestPair.current.id, 1000).catch(() => {
      // best effort background warmup
    });
  };

  ipcMain.handle("diskhound:compute-scan-diff", async (_event, baselineId: string, currentId: string) => {
    const [baseline, current] = await Promise.all([
      loadHistoricalSnapshotCached(baselineId),
      loadHistoricalSnapshotCached(currentId),
    ]);
    if (!baseline || !current) return null;
    return computeDiff(baseline, current, baselineId, currentId);
  });

  ipcMain.handle("diskhound:get-full-diff-status", async (
    _event,
    baselineId: string,
    currentId: string,
    limit?: number,
  ): Promise<FullDiffStatus> => {
    const normalizedLimit = normalizeDiffLimit(limit);
    const [cached, baselineIndexBytes, currentIndexBytes] = await Promise.all([
      hasFullDiffCache(baselineId, currentId, normalizedLimit),
      getIndexBytes(baselineId),
      getIndexBytes(currentId),
    ]);
    return {
      baselineId,
      currentId,
      limit: normalizedLimit,
      cached,
      baselineIndexBytes,
      currentIndexBytes,
    };
  });

  ipcMain.handle("diskhound:compute-full-scan-diff", async (_event, baselineId: string, currentId: string, limit?: number) => {
    return await loadOrComputeFullDiff(baselineId, currentId, limit);
  });

  // Load a dense file list for the treemap from the persisted full-file index.
  // Returns the top N files by size across the whole scan (not just the
  // top-N tracked in memory). Used for WinDirStat-style dense visualization.
  ipcMain.handle("diskhound:get-treemap-files", async (_event, rootPath: string, limit: number = 10_000) => {
    const pair = getLatestPair(rootPath);
    const history = getScanHistory(rootPath);
    const currentId = pair?.current.id ?? history[0]?.id;
    if (!currentId) return [];

    treemapCache.rememberLatest(rootPath, currentId);

    const latestSnapshot = await loadHistoricalSnapshotCached(currentId);
    if (latestSnapshot && latestSnapshot.largestFiles.length >= limit) {
      return latestSnapshot.largestFiles.slice(0, limit);
    }

    try {
      return await treemapCache.getOrLoad({
        scanId: currentId,
        rootPath,
        indexPath: indexFilePath(currentId),
        limit,
      });
    } catch {
      treemapCache.invalidateScan(currentId);
      return [];
    }
  });

  /**
   * Direct-children-by-folder lookup for the Folders tab. The first call
   * per scan ID streams the persisted NDJSON once and builds a full
   * parent-path → {dirs, files} map in main-process memory. Every
   * subsequent call is an O(1) lookup into that map — which is what
   * turns the Folders tab drill-in from "multi-second wait per click"
   * into instant navigation.
   *
   * Cache is keyed by scanId and evicted when a newer scan for the
   * same root completes (see afterScanDone below). Memory is bounded
   * by the folder count in the tree, not file count: even a 7M-file
   * drive with 100k folders costs only a few MB.
   */
  /**
   * Compact on-heap representation of a file inside the folder-tree
   * cache. We store just the FILENAME (~15 bytes on average) — the
   * parent path is already the Map key, so storing the file's full
   * path was pure duplication. On a 7.27 M-file drive that cut each
   * file entry from ~280 bytes to ~110 bytes — around 850 MB off the
   * cache footprint at the observed 5M file-records total.
   *
   * Expanded to the full ScanFileRecord shape at the IPC boundary
   * via makeFolderFileRecord() below.
   */
  type CompactFolderFile = {
    name: string;
    size: number;
    modifiedAt: number;
  };
  type FolderNode = {
    dirs: { path: string; size: number; fileCount: number }[];
    files: CompactFolderFile[];
  };
  type FolderTree = Map<string, FolderNode>;

  /**
   * Reconstruct a full ScanFileRecord from the compact cached form.
   * Takes the parent path explicitly because the cache omits it — it's
   * the Map key the caller already has.
   */
  const makeFolderFileRecord = (parentPath: string, f: CompactFolderFile): ScanFileRecord => {
    const dotIdx = f.name.lastIndexOf(".");
    const extension = dotIdx > 0 ? f.name.slice(dotIdx).toLowerCase() : "(no ext)";
    return {
      path: `${parentPath}${Path.sep}${f.name}`,
      name: f.name,
      parentPath,
      extension,
      size: f.size,
      modifiedAt: f.modifiedAt,
    };
  };
  /**
   * In-memory cache of built folder trees, keyed by scan ID.
   *
   * Eviction policy: bounded both by scan count (at most N trees) AND
   * by total parent-path entries across ALL trees. The entry cap is
   * what actually protects the heap — a C:\ drive can produce a tree
   * with 1M+ parent paths, and keeping two or three of those in
   * memory runs the main process to a gigabyte+.
   *
   * LRU within the Map's insertion-order semantics (delete + set moves
   * the entry to the tail on access).
   */
  const FOLDER_TREE_MAX_SCANS = 3;
  const FOLDER_TREE_MAX_TOTAL_ENTRIES = 600_000;
  const folderTreeCache: Map<string, FolderTree> = new Map();
  const folderTreeInflight: Map<string, Promise<FolderTree>> = new Map();
  // Track which root each cached/inflight tree belongs to so we can
  // evict the PRIOR tree for root R the moment R gets a new scan.
  // Without this, a fresh C:\ scan would build a new 1M-entry tree
  // while the previous C:\ tree was still in the cache — peak memory
  // doubled during every same-root rescan cycle.
  const folderTreeRootByScanId: Map<string, string> = new Map();
  let folderTreeTotalEntries = 0;

  const evictOldestFolderTree = (): boolean => {
    const oldest = folderTreeCache.keys().next().value;
    if (oldest === undefined) return false;
    const tree = folderTreeCache.get(oldest);
    folderTreeCache.delete(oldest);
    folderTreeTotalEntries -= tree?.size ?? 0;
    if (folderTreeTotalEntries < 0) folderTreeTotalEntries = 0;
    return true;
  };

  const insertFolderTree = (id: string, tree: FolderTree) => {
    // Honour BOTH caps — scan count first, then total-entry pressure.
    folderTreeCache.set(id, tree);
    folderTreeTotalEntries += tree.size;
    while (folderTreeCache.size > FOLDER_TREE_MAX_SCANS) {
      if (!evictOldestFolderTree()) break;
    }
    while (folderTreeTotalEntries > FOLDER_TREE_MAX_TOTAL_ENTRIES && folderTreeCache.size > 1) {
      if (!evictOldestFolderTree()) break;
    }
  };

  const touchFolderTree = (id: string) => {
    const tree = folderTreeCache.get(id);
    if (!tree) return;
    // Re-insert to bump it to the LRU tail.
    folderTreeCache.delete(id);
    folderTreeCache.set(id, tree);
  };

  // ── Folder tree persistence (sidecar on disk) ──────────────────────
  //
  // We write the built tree to `<scanId>.folder-tree.ndjson.gz` next
  // to the scan index. On subsequent app launches (or Folders-tab
  // clicks after eviction), ensureFolderTree reads the sidecar
  // directly — skipping the multi-second stream-and-parse of the full
  // gzipped file index. Format is one NDJSON line per parent entry:
  //
  //   {"k":"c:\\users","d":[["c:\\users\\foo",12345,6]],"f":[["file.txt",1024,1700000000000]]}
  //
  // k: parent path (Map key)
  // d: direct child dirs as [fullChildPath, recursiveSize, recursiveFileCount]
  // f: direct files as [filename, size, modifiedAt]  (compact form)
  //
  // Invalidation: the sidecar is deleted whenever the scan it
  // references is pruned from history (see consumeLastPrunedIds path).
  // Because the sidecar filename is keyed by the scan's UUID, a fresh
  // scan writes its own sidecar and the old one gets garbage-collected
  // when the corresponding history entry rolls off.
  // folderTreeSidecarPath is imported from ./shared/scanIndex so the
  // Rust scanner (which we pass the path to via --folder-tree-output)
  // and the Node reader here agree on exactly one location per scan.

  async function writeFolderTreeSidecar(scanId: string, tree: FolderTree): Promise<void> {
    if (tree.size === 0) return; // nothing to persist
    const filePath = folderTreeSidecarPath(scanId);
    const tempPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
    try {
      const { createWriteStream } = await import("node:fs");
      const { pipeline } = await import("node:stream/promises");
      const { Readable } = await import("node:stream");

      // Build an async iterable that yields one NDJSON line per entry.
      // Using a generator keeps us from concat'ing the whole payload
      // into one giant string — the caller can have 1M+ entries.
      async function* emitLines(): AsyncGenerator<string> {
        for (const [parent, node] of tree) {
          const line = JSON.stringify({
            k: parent,
            d: node.dirs.map((d) => [d.path, d.size, d.fileCount]),
            f: node.files.map((f) => [f.name, f.size, f.modifiedAt]),
          });
          yield line + "\n";
        }
      }

      const gz = createGzip({ level: 4 });
      const out = createWriteStream(tempPath);
      await pipeline(Readable.from(emitLines()), gz, out);
      await FS.rename(tempPath, filePath);
    } catch (err) {
      try { await FS.unlink(tempPath); } catch { /* best effort */ }
      writeCrashLog(
        "folder-tree-sidecar-write",
        err instanceof Error ? (err.stack ?? err.message) : String(err),
      );
    }
  }

  async function readFolderTreeSidecar(scanId: string): Promise<FolderTree | null> {
    const filePath = folderTreeSidecarPath(scanId);
    if (!FS_SYNC.existsSync(filePath)) {
      writeCrashLog(
        "folder-tree-sidecar-read",
        `scanId=${scanId} file missing at ${filePath} — will rebuild from index`,
      );
      return null;
    }

    const tree: FolderTree = new Map();
    let linesRead = 0;
    let parseFailures = 0;
    try {
      const gunzip = createGunzip();
      const src = createReadStream(filePath);
      src.pipe(gunzip);
      const rl = createInterface({ input: gunzip, crlfDelay: Infinity });
      for await (const line of rl) {
        if (!line) continue;
        linesRead++;
        let rec: {
          k?: string;
          d?: [string, number, number][];
          f?: [string, number, number][];
        };
        try { rec = JSON.parse(line); } catch { parseFailures++; continue; }
        if (typeof rec.k !== "string") continue;
        const dirs = Array.isArray(rec.d)
          ? rec.d
              .filter((row) => Array.isArray(row) && row.length >= 3)
              .map(([path, size, fileCount]) => ({ path, size, fileCount }))
          : [];
        const files = Array.isArray(rec.f)
          ? rec.f
              .filter((row) => Array.isArray(row) && row.length >= 3)
              .map(([name, size, modifiedAt]) => ({ name, size, modifiedAt }))
          : [];
        tree.set(rec.k, { dirs, files });
      }
      // Log success/failure ratio so we can tell if a sidecar was
      // present-but-corrupt (rare, but hard to diagnose without
      // explicit instrumentation). Before this, a sidecar that
      // parsed to 0 entries would silently fall through to the
      // worker-based rebuild, which OOM'd on big drives and made
      // the Folders tab unusable after app restart.
      writeCrashLog(
        "folder-tree-sidecar-read",
        `scanId=${scanId} lines=${linesRead} parseFailures=${parseFailures} treeSize=${tree.size}`,
      );
      return tree;
    } catch (err) {
      writeCrashLog(
        "folder-tree-sidecar-read",
        `scanId=${scanId} linesRead=${linesRead} error=${err instanceof Error ? (err.stack ?? err.message) : String(err)}`,
      );
      return null;
    }
  }

  async function deleteFolderTreeSidecar(scanId: string): Promise<void> {
    try { await FS.unlink(folderTreeSidecarPath(scanId)); } catch { /* already gone */ }
  }

  /**
   * Build-or-get: returns the cached tree when we have one, otherwise
   * builds it exactly once even if called multiple times concurrently.
   * Used both by the IPC handler AND the post-scan pre-warm path, so
   * the user's first drill-in on a fresh scan hits a warm cache.
   *
   * Optional `rootPath` is remembered in folderTreeRootByScanId so a
   * later same-root scan can evict stale siblings.
   *
   * Optional `abortIfMemoryOverMb` lets the PRE-WARM path skip the
   * build when the main process is already sitting on a lot of heap
   * (e.g. right after a huge scan completes). Returns an empty tree
   * in that case instead of crashing the process with OOM — the user
   * will pay the cold-build cost on their next Folders click, but
   * the app survives to do it.
   *
   * Build path:
   *   1. Check in-memory cache → instant
   *   2. Check in-flight promise → coalesce concurrent requests
   *   3. Check on-disk sidecar → ~2-4 s on a drive-scale tree
   *   4. Stream scan index from scratch → ~5-15 s on a drive-scale
   *      tree (original cost); writes sidecar on success
   */
  const PREWARM_RSS_CEILING_MB = 5500;
  const ensureFolderTree = async (
    id: string,
    rootPath?: string,
    opts?: { skipIfMemoryPressureMb?: number },
  ): Promise<FolderTree> => {
    if (rootPath) folderTreeRootByScanId.set(id, normPath(rootPath));
    const existing = folderTreeCache.get(id);
    if (existing) {
      touchFolderTree(id);
      return existing;
    }
    const inflight = folderTreeInflight.get(id);
    if (inflight) return inflight;
    if (opts?.skipIfMemoryPressureMb) {
      const rssMb = process.memoryUsage().rss / 1024 / 1024;
      if (rssMb > opts.skipIfMemoryPressureMb) {
        writeCrashLog(
          "folder-tree-prewarm-skipped",
          `RSS ${rssMb.toFixed(0)} MB > ${opts.skipIfMemoryPressureMb} MB — skipping pre-warm to avoid OOM. User's first Folders click will build cold.`,
        );
        return new Map();
      }
    }

    const pending = (async () => {
      // Try the persisted sidecar first. Writing the sidecar is
      // best-effort (see writeFolderTreeSidecar), so a missing or
      // corrupt file just falls through to the full rebuild path.
      const started = Date.now();
      const sidecarFilePresent = FS_SYNC.existsSync(folderTreeSidecarPath(id));
      const fromDisk = await readFolderTreeSidecar(id);
      if (fromDisk && fromDisk.size > 0) {
        writeCrashLog(
          "folder-tree-sidecar-hit",
          `scanId=${id} entries=${fromDisk.size} load=${Date.now() - started}ms`,
        );
        insertFolderTree(id, fromDisk);
        return fromDisk;
      }
      // Sidecar exists but parsed to an empty Map — don't rebuild via
      // the worker. The worker reads the SAME scan's NDJSON index;
      // on drives big enough to need the sidecar fast-path, that
      // rebuild OOMs the worker (observed in crash.log:
      // "[folder-tree-prewarm-boot] Error: Folder tree worker out of
      // memory, 8 GB heap"). Returning an empty tree keeps the
      // Folders tab responsive (shows an empty state) and a
      // subsequent scan will produce a fresh, readable sidecar.
      if (sidecarFilePresent) {
        writeCrashLog(
          "folder-tree-sidecar-empty-skip-rebuild",
          `scanId=${id} sidecar parsed to 0 entries — skipping worker rebuild to avoid OOM. Run a fresh scan to regenerate.`,
        );
        const empty: FolderTree = new Map();
        insertFolderTree(id, empty);
        return empty;
      }
      const tree = await buildFolderTree(indexFilePath(id));
      insertFolderTree(id, tree);
      // Fire-and-forget sidecar write so the NEXT ensure call for this
      // scanId hits the fast disk path. Errors logged, don't block.
      void writeFolderTreeSidecar(id, tree);
      return tree;
    })().finally(() => {
      folderTreeInflight.delete(id);
    });
    folderTreeInflight.set(id, pending);
    return pending;
  };

  const invalidateFolderTree = (id: string) => {
    const tree = folderTreeCache.get(id);
    if (tree) {
      folderTreeCache.delete(id);
      folderTreeTotalEntries -= tree.size;
      if (folderTreeTotalEntries < 0) folderTreeTotalEntries = 0;
    }
    folderTreeInflight.delete(id);
    folderTreeRootByScanId.delete(id);
  };

  /**
   * Drop every cached folder tree that belongs to the given root
   * EXCEPT the excluded scan ID. Called on scan-complete so the new
   * scan's tree supersedes the prior one for that same drive instead
   * of sharing heap space with it.
   */
  const invalidateFolderTreesForRoot = (rootPath: string, exceptScanId: string | null) => {
    const rootKey = normPath(rootPath);
    for (const [scanId, tracked] of folderTreeRootByScanId) {
      if (tracked === rootKey && scanId !== exceptScanId) {
        invalidateFolderTree(scanId);
      }
    }
  };

  /**
   * Memory diagnostic summary including the caches we know can grow
   * (folder-tree parent count, treemap cache entries, full-diff memory
   * cache size). Useful for "why is DiskHound holding 800 MB?" triage.
   */
  const describeCacheMemory = (): string => {
    const treemapStats = treemapCache.getStats();
    return [
      describeMemoryUsage(),
      `folderTree: ${folderTreeCache.size} trees, ${folderTreeTotalEntries.toLocaleString()} entries`,
      `treemapCache: ${treemapStats.entries} entries, ${treemapStats.inflight} inflight`,
      `fullDiffMem: ${fullDiffCache.size} entries`,
    ].join(" | ");
  };

  // Log a memory snapshot on a cadence that tracks activity:
  //   - 1 minute while a scan is live (catches the peak mid-walk)
  //   - 5 minutes when idle (enough to notice slow leaks without
  //     spamming the log when nothing's happening)
  // Unref so it doesn't keep the process alive on quit.
  let memoryDiagIntervalHandle: ReturnType<typeof setInterval> | null = null;
  let memoryDiagCadence: "scanning" | "idle" = "idle";
  const startMemoryDiag = (cadence: "scanning" | "idle") => {
    if (memoryDiagIntervalHandle) clearInterval(memoryDiagIntervalHandle);
    const ms = cadence === "scanning" ? 60 * 1000 : 5 * 60 * 1000;
    memoryDiagIntervalHandle = setInterval(() => {
      const tag = activeScans.size > 0 ? "memory-scanning" : "memory";
      writeCrashLog(tag, describeCacheMemory());
    }, ms);
    memoryDiagIntervalHandle.unref?.();
    memoryDiagCadence = cadence;
  };
  /**
   * Bump the cadence to 1 min while a scan is active and drop back to
   * 5 min when everything settles. Called from the running/done scan
   * broadcast paths so we cover both manual and scheduled scans.
   */
  const retuneMemoryDiagCadence = () => {
    const desired: "scanning" | "idle" = activeScans.size > 0 ? "scanning" : "idle";
    if (desired !== memoryDiagCadence) startMemoryDiag(desired);
  };
  startMemoryDiag("idle");
  // One snapshot at boot for the "after restart" baseline.
  writeCrashLog("memory", `boot: ${describeCacheMemory()}`);

  // Pre-warm the folder tree for the last rehydrated scan so the
  // Folders tab is instant on app launch. Fire-and-forget — the user
  // won't notice the seconds-long index read because it happens in
  // the background before they've had a chance to click the tab.
  void (async () => {
    try {
      const rehydrated = await scanStore.get();
      if (!rehydrated || rehydrated.status !== "done" || !rehydrated.rootPath) return;
      const hist = getScanHistory(rehydrated.rootPath);
      const latestId = hist[0]?.id;
      if (!latestId) return;
      await ensureFolderTree(latestId, rehydrated.rootPath);
    } catch (err) {
      writeCrashLog(
        "folder-tree-prewarm-boot",
        err instanceof Error ? (err.stack ?? err.message) : String(err),
      );
    }
  })();

  /**
   * Build a full parent → children map by streaming the index once.
   *
   * The actual streaming + aggregation happens inside a dedicated Node
   * worker thread (src/scan/folderTreeWorker.ts) so the ~5-minute build
   * on a drive-scale scan (7M+ files) no longer blocks the main
   * thread's event loop. Before this was worker-offloaded, the per-line
   * JSON.parse + Map churn saturated the event loop hard enough that
   * setInterval heartbeats ([memory] logs) stopped firing and IPC
   * handlers stalled behind the microtask flood — the user saw the app
   * freeze for several minutes right after scan-complete with no log
   * output.
   *
   * The worker returns a serialized [key, node] array over postMessage;
   * we wrap it back into a FolderTree Map on receipt. Tree shape is
   * unchanged so every downstream consumer (IPC handlers, sidecar
   * writer, cache eviction) keeps working without edits.
   */
  async function buildFolderTree(indexPathStr: string): Promise<FolderTree> {
    // This is the FALLBACK path — ensureFolderTree above calls
    // readFolderTreeSidecar first, so we only get here when the
    // scanner didn't emit a sidecar OR the sidecar was deleted. The
    // worker streams the NDJSON index from scratch; ~5-15 s on a
    // drive-scale scan.
    const serialized = await runFolderTreeWorker(
      { indexPath: indexPathStr },
      { workerPath: folderTreeWorkerEntry },
    );
    const tree: FolderTree = new Map();
    for (const [key, node] of serialized) {
      tree.set(key, node);
    }
    return tree;
  }

  ipcMain.handle(
    "diskhound:get-folder-children",
    async (_event, rootPath: string, parentPath: string) => {
      const history = getScanHistory(rootPath);
      const currentId = history[0]?.id;
      if (!currentId) return { dirs: [], files: [] };

      try {
        const tree = await ensureFolderTree(currentId, rootPath);
        const normalizedParent = normPath(parentPath).replace(/[\\/]+$/, "");
        const node = tree.get(normalizedParent);
        if (!node) return { dirs: [], files: [] };
        // Expand the compact in-cache file shape into the full
        // ScanFileRecord the renderer expects. Done on the way out
        // because the cache holds 1M+ parent entries and duplicating
        // name/parentPath/extension per file would burn hundreds of
        // MB of heap for no runtime benefit. The cache stores filenames
        // only — we pass `normalizedParent` so the full path can be
        // reconstructed for the renderer.
        return {
          dirs: node.dirs,
          files: node.files.map((f) => makeFolderFileRecord(normalizedParent, f)),
        };
      } catch (err) {
        writeCrashLog(
          "folder-tree",
          err instanceof Error ? (err.stack ?? err.message) : String(err),
        );
        return { dirs: [], files: [] };
      }
    },
  );

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
    const resolvedRoot = Path.resolve(rootPath);
    const key = scanKey(resolvedRoot);

    // Only cancel an existing scan for THIS root. Scans on other drives
    // keep running — parallel duplicate detection was one of the major
    // asks in v0.3.1.
    const existing = activeDuplicateScans.get(key);
    if (existing) {
      existing.cancel();
      activeDuplicateScans.delete(key);
    }

    // Try to find an existing scan index whose root is an ancestor of the
    // duplicates scope — streaming that index is much faster and lower
    // memory than re-walking the filesystem. Fall back to walk if no
    // suitable index exists or if the path isn't under any known scan.
    const indexPath = findIndexCoveringPath(resolvedRoot);

    const handle = runDuplicateScan(
      resolvedRoot,
      {
        onProgress: (progress) => {
          // Tag every progress emission with the rootPath so the
          // renderer can route it to the right per-drive state slot.
          mainWindow?.webContents.send(DUPLICATE_PROGRESS_CHANNEL, {
            ...progress,
            rootPath: resolvedRoot,
          });
        },
        onResult: (result) => {
          mainWindow?.webContents.send(DUPLICATE_RESULT_CHANNEL, result);
          activeDuplicateScans.delete(key);
          sendToast("success", "Duplicate scan complete",
            `Found ${result.totalGroups} group${result.totalGroups === 1 ? "" : "s"} in ${resolvedRoot}, ${formatBytesShort(result.totalWastedBytes)} reclaimable.`);
        },
        onError: (error) => {
          mainWindow?.webContents.send(DUPLICATE_PROGRESS_CHANNEL, {
            rootPath: resolvedRoot,
            status: "error",
            filesWalked: 0,
            candidateGroups: 0,
            filesHashed: 0,
            groupsConfirmed: 0,
            elapsedMs: 0,
            errorMessage: error.message,
          });
          activeDuplicateScans.delete(key);
        },
      },
      {
        indexPath,
        minSizeBytes: options?.minSizeBytes,
        // Enable the persistent hash cache so repeat duplicate scans
        // on the same drive skip re-hashing unchanged files. The
        // first scan on a drive pays the full 30-60 minute hashing
        // cost; subsequent scans reuse cached hashes by
        // (path, size, mtime) and finish in seconds for unchanged
        // files.
        cacheDir: app.getPath("userData"),
      },
    );
    activeDuplicateScans.set(key, handle);
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
    // Platform-aware: normPath lowercases only on Windows. On Linux /
    // macOS case-sensitive volumes, "/home/Alice" and "/home/alice" are
    // genuinely distinct roots; unconditional lowercase used to falsely
    // match them, causing the duplicates scan to stream the wrong
    // index.
    const normalizedTarget = normPath(Path.resolve(path));
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
      const normalizedRoot = normPath(Path.resolve(r.path));
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

  ipcMain.handle("diskhound:cancel-duplicate-scan", (_event, rootPath?: string) => {
    if (rootPath) {
      const key = scanKey(Path.resolve(rootPath));
      const handle = activeDuplicateScans.get(key);
      if (handle) {
        handle.cancel();
        activeDuplicateScans.delete(key);
      }
      return;
    }
    // No rootPath → cancel all (e.g. app quit, or renderer asking for a full stop).
    for (const handle of activeDuplicateScans.values()) handle.cancel();
    activeDuplicateScans.clear();
  });

  ipcMain.handle("diskhound:get-active-duplicate-scan-roots", () => {
    // Return the rootPaths (original casing) the renderer originally
    // passed in. Since we key by normPath(), we can't recover original
    // casing reliably — return the normalized keys, which matches how
    // the renderer normalizes them internally.
    return Array.from(activeDuplicateScans.keys());
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
      treemapCache.rememberLatest(rootPath, historyId);

      // Carry the predecessor's folder-tree sidecar forward.
      //
      // USN rescans update the NDJSON index with deltas, but the
      // folder-tree sidecar is only written by the Rust scanner's
      // full-scan/walker path — NEVER by runIncrementalScan. Without
      // this copy, history[0] (the USN scan) lands in userData with
      // NO sidecar, and the next Folders-tab open falls through to
      // buildFolderTree which streams the 300+ MB gzipped NDJSON
      // into the worker (slow + OOM-prone on big drives; observed
      // as "folder tree worker out of memory" + truncated Folders
      // results).
      //
      // The predecessor's sidecar is accurate for 99%+ of a USN
      // rescan (deltas are a tiny fraction of total entries) and is
      // refreshed on the next full scan. A slightly stale sidecar
      // beats a 300 MB rebuild that might OOM.
      try {
        const prevSidecar = folderTreeSidecarPath(mostRecent.id);
        const nextSidecar = folderTreeSidecarPath(historyId);
        if (FS_SYNC.existsSync(prevSidecar) && !FS_SYNC.existsSync(nextSidecar)) {
          await FS.copyFile(prevSidecar, nextSidecar);
          writeCrashLog(
            "folder-tree-sidecar-carry-forward",
            `usn scan ${historyId} carried forward sidecar from ${mostRecent.id}`,
          );
        }
      } catch (err) {
        writeCrashLog(
          "folder-tree-sidecar-carry-forward",
          `copy failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }

      // Evict the prior tree for this root before building the new
      // one so peak memory doesn't double during the swap.
      invalidateFolderTreesForRoot(rootPath, historyId);
      // Same deferred pre-warm as the full-scan path — 3 s gap lets
      // V8 reclaim scan-time transients before we allocate ~500-800
      // MB for the new folder tree.
      const prewarmId = historyId;
      const prewarmRoot = rootPath;
      setTimeout(() => {
        void ensureFolderTree(prewarmId, prewarmRoot, {
          skipIfMemoryPressureMb: PREWARM_RSS_CEILING_MB,
        }).catch((err) => {
          writeCrashLog(
            "folder-tree-prewarm",
            err instanceof Error ? (err.stack ?? err.message) : String(err),
          );
        });
      }, 3000);
    } catch { /* ignore */ }

    for (const prunedId of consumeLastPrunedIds()) {
      treemapCache.invalidateScan(prunedId);
      invalidateFolderTree(prunedId);
      void deleteFolderTreeSidecar(prunedId);
      void deleteIndex(prunedId);
      void deleteFullDiffCachesForScan(prunedId);
    }

    await broadcastSnapshot(result.snapshot);
    markFullScan();
    warmLatestFullDiff(rootPath);

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
    const appIconPath = resolveAppIconPath();
    const appIconImage = createAppIconImage();
    // Linux: prefer the multi-rep NativeImage so the WM picks the
    // right pixels for each chrome slot (16 px title-bar, 48 px dock,
    // 128 px switcher, …). Fall back to the 512 PNG path if the
    // icons/ directory wasn't shipped for some reason.
    // Windows + macOS: packaging already embeds the correct icon
    // (ICO / ICNS) in the binary, so the `icon` option is mostly
    // redundant there — we only set it on Linux.
    const linuxIcon: Electron.BrowserWindowConstructorOptions["icon"] | undefined =
      process.platform === "linux"
        ? (appIconImage ?? appIconPath ?? undefined)
        : undefined;

    // Restored geometry from the previous session, or defaults on
    // first launch / when the saved position is on a now-disconnected
    // monitor (windowStateStore.resolveBounds drops x/y in that case
    // so the WM centers the window instead of stranding it).
    const savedBounds = windowStateStore?.resolveBounds() ?? {
      width: 1560,
      height: 980,
    };

    mainWindow = new BrowserWindow({
      ...savedBounds,
      minWidth: 960,
      minHeight: 640,
      backgroundColor: "#0a0a0f",
      title: isDevelopment ? "DiskHound (Dev)" : "DiskHound",
      ...(linuxIcon ? { icon: linuxIcon } : {}),
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

    // Some Linux window managers (notably GNOME Shell with the default
    // dash-to-dock) ignore the constructor `icon` option and only read
    // the icon after the window is realized. Explicit setIcon() after
    // construction covers that case. No-op on macOS / Windows (the
    // bundled ICNS / ICO is authoritative there).
    if (process.platform === "linux" && appIconImage) {
      try {
        mainWindow.setIcon(appIconImage);
      } catch {
        /* non-fatal — WM just uses the default Electron icon */
      }
    }

    // Re-apply maximize / fullscreen from the saved state. We can't
    // pass these as BrowserWindow constructor options, so it has to
    // happen post-construction. setFullScreen wins over maximize:
    // they're mutually exclusive in practice, but if both flags
    // somehow ended up true (ought-to-be-impossible on a single
    // window, but we read them out of a JSON file users could edit),
    // fullscreen is the more recent state to honor. Fullscreen on
    // macOS opens a new Space and animates ~500 ms; users see the
    // app come up at last-session geometry then transition.
    if (windowStateStore?.shouldRestoreFullScreen()) {
      mainWindow.setFullScreen(true);
    } else if (windowStateStore?.shouldRestoreMaximized()) {
      mainWindow.maximize();
    }

    // Attach the resize/move/maximize listeners that capture future
    // geometry changes. Persistence is debounced inside the store so
    // a slow drag doesn't generate a write per frame.
    windowStateStore?.track(mainWindow);

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
  const linuxManualUpdateBuild = process.platform === "linux" && !process.env.APPIMAGE;
  // Interval between automatic update checks once the app is running.
  // 4 hours is a middle ground — fast enough to catch same-day releases
  // without thrashing GitHub's rate limit on always-on installs.
  const UPDATE_CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000;

  /**
   * Persisted timestamp of the last time we successfully *attempted* an
   * update check (whether or not an update was available). Stored on
   * the in-memory updateState stub — the renderer pulls it via
   * getUpdateState() on mount so "last checked" survives restarts
   * instead of reading "Never" every time the app cold-boots.
   */
  const updaterStatePath = Path.join(app.getPath("userData"), "updater-state.json");
  type UpdaterState = { lastCheckedAt: number | null };
  const readUpdaterState = (): UpdaterState => {
    try {
      const raw = FS_SYNC.readFileSync(updaterStatePath, "utf8");
      const parsed = JSON.parse(raw) as Partial<UpdaterState>;
      if (typeof parsed.lastCheckedAt === "number") {
        return { lastCheckedAt: parsed.lastCheckedAt };
      }
    } catch { /* missing / corrupt — treat as "never checked" */ }
    return { lastCheckedAt: null };
  };
  let updaterState: UpdaterState = readUpdaterState();
  const persistUpdaterState = () => {
    try {
      FS_SYNC.writeFileSync(updaterStatePath, JSON.stringify(updaterState));
    } catch { /* best effort */ }
  };

  const emitUpdateStatus = (status: import("./shared/contracts").UpdateStatus) => {
    const enriched = {
      ...status,
      lastCheckedAt: updaterState.lastCheckedAt,
    };
    mainWindow?.webContents.send(UPDATE_STATUS_CHANNEL, enriched);
  };

  const recordCheck = () => {
    updaterState = { lastCheckedAt: Date.now() };
    persistUpdaterState();
  };

  if (!isDevelopment && !linuxManualUpdateBuild) {
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
        recordCheck();
        emitUpdateStatus({ phase: "available", currentVersion, availableVersion: info?.version });
        sendToast("info", "Update available", `DiskHound ${info?.version ?? ""} is available. Downloading...`);
        autoUpdater.downloadUpdate().catch(() => {});
      });
      autoUpdater.on("update-not-available", (info: any) => {
        recordCheck();
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
        // Still record the attempt — users ask "did it try?" and
        // repeated network errors shouldn't look like no activity.
        recordCheck();
        emitUpdateStatus({ phase: "error", currentVersion, errorMessage: err?.message });
      });

      const scheduleUpdateCheck = () => {
        if (!settingsStore?.get().general.autoUpdate) return;
        autoUpdater.checkForUpdates().catch(() => {});
      };

      // Check on boot only if the user has auto-update enabled
      if (settings.general.autoUpdate) {
        scheduleUpdateCheck();
      }

      // Re-check every UPDATE_CHECK_INTERVAL_MS so long-running installs
      // pick up releases without needing a manual click. setInterval is
      // cleared in before-quit.
      setInterval(scheduleUpdateCheck, UPDATE_CHECK_INTERVAL_MS).unref?.();
    } catch {
      // electron-updater not available (dev mode or build issue)
    }
  }

  if (linuxManualUpdateBuild) {
    emitUpdateStatus({
      phase: "manual",
      currentVersion,
      manualMessage: "Automatic updates are only supported for the AppImage build. Use GitHub releases for tar.gz or other manual Linux installs.",
    });
  }

  ipcMain.handle("diskhound:check-for-updates", async () => {
    if (linuxManualUpdateBuild) {
      void shell.openExternal(RELEASES_URL);
      emitUpdateStatus({
        phase: "manual",
        currentVersion,
        manualMessage: "Automatic updates are only supported for the AppImage build. Opened GitHub releases instead.",
      });
      return;
    }
    if (!autoUpdater) return;
    try { await autoUpdater.checkForUpdates(); } catch { /* ignore */ }
  });

  // Returns the persisted last-checked timestamp so the Settings UI can
  // show "Last checked 4h ago" immediately after app launch, instead of
  // the stale-looking "Never" that the in-memory UpdateStatus gives us.
  ipcMain.handle("diskhound:get-update-state", () => {
    return {
      lastCheckedAt: updaterState.lastCheckedAt,
      currentVersion,
    };
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
    for (const handle of activeDuplicateScans.values()) {
      handle.cancel();
    }
    activeDuplicateScans.clear();
    if (monitoringInterval) {
      clearInterval(monitoringInterval);
      monitoringInterval = null;
    }
    if (tray) {
      tray.destroy();
      tray = null;
    }
    treemapCache.clear();
    // Flush pending window-state debounce so the final geometry
    // (e.g. user dragged the window then quit within 400 ms) is
    // written to disk before the process exits. Fire-and-forget —
    // app.before-quit is synchronous from Electron's POV; if the
    // write hasn't finished by app.quit() we lose at most one
    // session's geometry, which is the same outcome as a kernel
    // panic would produce. The window's own close listener also
    // calls persistNow as a belt-and-suspenders.
    void windowStateStore?.flush();
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
