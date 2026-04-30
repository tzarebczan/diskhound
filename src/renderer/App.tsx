import { useCallback, useEffect, useMemo, useState } from "preact/hooks";

import {
  type AppSettings,
  createIdleScanSnapshot,
  defaultScanOptions,
  type AppView,
  type DiskSpaceInfo,
  type DuplicateAnalysis,
  type DuplicateScanProgress,
  type GeneralSettings,
  type ScanOptions,
  type ScanSnapshot,
  type UpdateStatus,
} from "../shared/contracts";
import { formatBytes } from "./lib/format";
import { setColorBlindPalette } from "./lib/treemap";
import { setProcessPaletteColorBlind } from "./components/MemoryView";
import { dispatchSettingsUpdated, SETTINGS_UPDATED_EVENT } from "./lib/uiEvents";
import { nativeApi } from "./nativeApi";

import { ChangesView } from "./components/ChangesView";
import { DiskPicker } from "./components/DiskPicker";
import { DuplicatesView } from "./components/DuplicatesView";
import { DiskIoView } from "./components/DiskIoView";
import { MemoryView } from "./components/MemoryView";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { ShortcutHelp } from "./components/ShortcutHelp";
import { EasyMoveView } from "./components/EasyMoveView";
import { FileList } from "./components/FileList";
import { FolderList } from "./components/FolderList";
import { Overview } from "./components/Overview";
import { StartupSplash } from "./components/StartupSplash";
import { SettingsView } from "./components/SettingsView";
import { ToastProvider, dismissToast, toast } from "./components/Toasts";

const TABS: { id: AppView; label: string; key: string }[] = [
  { id: "overview", label: "Overview", key: "1" },
  { id: "files", label: "Largest Files", key: "2" },
  { id: "folders", label: "Folders", key: "3" },
  { id: "duplicates", label: "Duplicates", key: "4" },
  { id: "changes", label: "Changes", key: "5" },
  { id: "easyMove", label: "Easy Move", key: "6" },
  { id: "memory", label: "Processes", key: "7" },
  { id: "diskIo", label: "Disk I/O", key: "8" },
  { id: "settings", label: "Settings", key: "9" },
];

const SEARCHABLE_VIEWS: readonly AppView[] = ["files"];

function isEditableElement(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
  return target.isContentEditable;
}

function resolveThemePreference(theme: GeneralSettings["theme"]): "dark" | "light" {
  if (theme === "light") {
    return "light";
  }
  if (theme === "system") {
    return window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
  }
  return "dark";
}

function cycleThemePreference(theme: GeneralSettings["theme"]): GeneralSettings["theme"] {
  switch (theme) {
    case "dark":
      return "light";
    case "light":
      return "system";
    default:
      return "dark";
  }
}

function resolvePlatformClass(): "platform-windows" | "platform-macos" | "platform-linux" {
  switch (nativeApi.platform) {
    case "win32": return "platform-windows";
    case "darwin": return "platform-macos";
    default: return "platform-linux";
  }
}

/** Example path the scan-root input shows when empty. Platform-
 *  specific so Linux/Mac users aren't staring at a Windows-style
 *  path and guessing what DiskHound expects. */
function scanInputPlaceholder(): string {
  switch (nativeApi.platform) {
    case "win32": return "C:\\Users\\...";
    case "darwin": return "/Users/...";
    default: return "/home/...";
  }
}

/**
 * Normalize a root path for use as a snapshotsByRoot key. Case-insensitive
 * on Windows (where C:\ and c:\ are the same drive) and trims trailing
 * separators so "C:\\" and "C:\\Users\\..." collide correctly.
 */
function rootKey(rootPath: string | null | undefined): string {
  if (!rootPath) return "";
  const trimmed = rootPath.replace(/[\\/]+$/, "");
  if (nativeApi.platform === "win32") {
    return trimmed.toLowerCase();
  }
  return trimmed;
}

export function App() {
  // Per-root snapshot store — allows concurrent scans on different drives
  // and lets users switch drive views without losing each drive's state.
  // Each entry is the latest known snapshot for that root (from fresh
  // IPC broadcasts or from scan history).
  const [snapshotsByRoot, setSnapshotsByRoot] = useState<Map<string, ScanSnapshot>>(
    () => new Map(),
  );
  const [currentRoot, setCurrentRoot] = useState<string>("");
  /** Roots with an in-flight scan on the main process (normalized keys). */
  const [activeScanKeys, setActiveScanKeys] = useState<Set<string>>(() => new Set());

  // Per-root duplicate scan state. Lives at the App level so:
  //   1. Switching drives shows each drive's own stats (not a shared global)
  //   2. Running scans survive tab-switches (DuplicatesView unmounts when
  //      you move to another tab; lifting state up avoids losing progress)
  //   3. Multiple drives can have concurrent duplicate scans
  const [duplicateAnalysesByRoot, setDuplicateAnalysesByRoot] =
    useState<Map<string, DuplicateAnalysis>>(() => new Map());
  const [duplicateProgressByRoot, setDuplicateProgressByRoot] =
    useState<Map<string, DuplicateScanProgress>>(() => new Map());
  /** Normalized keys of roots with an in-flight duplicate scan. */
  const [activeDuplicateKeys, setActiveDuplicateKeys] = useState<Set<string>>(() => new Set());

  // Derived snapshot for the currently-viewed root. Defaults to an idle
  // snapshot that carries the current root so downstream views show the
  // right "Run a scan on C:\" empty state instead of just "no scan yet".
  const snapshot: ScanSnapshot = useMemo(() => {
    const existing = snapshotsByRoot.get(rootKey(currentRoot));
    if (existing) return existing;
    const idle = createIdleScanSnapshot();
    return currentRoot ? { ...idle, rootPath: currentRoot } : idle;
  }, [snapshotsByRoot, currentRoot]);

  // Setter used by the rest of the app — mirrors the old "rootPath" getter.
  const rootPath = currentRoot;
  const setRootPath = (path: string) => setCurrentRoot(path);

  const [scanOptions, setScanOptions] = useState<ScanOptions>(defaultScanOptions());
  const [view, setView] = useState<AppView>("overview");
  const [drives, setDrives] = useState<DiskSpaceInfo[]>([]);
  const [filterExt, setFilterExt] = useState<string | undefined>();
  // null = still loading the initial snapshot; prevents a flash of the picker
  // when we're about to restore a previous scan
  const [showPicker, setShowPicker] = useState<boolean | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const [hasPendingDiff, setHasPendingDiff] = useState(false);
  const [activeTheme, setActiveTheme] = useState<"dark" | "light">("dark");
  const [themePreference, setThemePreference] = useState<GeneralSettings["theme"]>("dark");
  const [updateStatus, setUpdateStatus] = useState<UpdateStatus | null>(null);
  const [shortcutHelpOpen, setShortcutHelpOpen] = useState(false);
  // Elevation status feeds the "Run as admin for faster scans" banner.
  // Null means we haven't probed yet; `elevated=true` AND
  // `scheduledTaskRegistered=true` independently suppress the banner
  // (the latter covers users who opted into the "always elevated"
  // scheduled-task path).
  const [elevationStatus, setElevationStatus] = useState<
    { elevated: boolean; scheduledTaskRegistered: boolean } | null
  >(null);
  const [adminBannerDismissed, setAdminBannerDismissed] = useState(() => {
    // Respect the one-time dismissal across sessions via localStorage.
    // Users who explicitly close the banner don't want to see it
    // every launch; they can still enable fast scans from Settings.
    try {
      return window.localStorage.getItem("diskhound.adminBannerDismissed") === "1";
    } catch {
      return false;
    }
  });
  useEffect(() => {
    let cancelled = false;
    void nativeApi.getElevationStatus().then((status) => {
      if (!cancelled) setElevationStatus(status);
    });
    return () => { cancelled = true; };
  }, []);
  const dismissAdminBanner = () => {
    setAdminBannerDismissed(true);
    try {
      window.localStorage.setItem("diskhound.adminBannerDismissed", "1");
    } catch { /* no-op */ }
  };
  const isSearchableView = SEARCHABLE_VIEWS.includes(view);

  /**
   * Compute an approximate scan-progress fraction [0, 0.99] for a
   * given root. Uses `bytesSeen / usedBytes` where `usedBytes =
   * totalBytes - freeBytes` for the drive the root lives on. Returns
   * null for non-running snapshots, roots we can't match to a known
   * drive (network mounts, folders outside any detected drive), and
   * the first sample before any bytes have been counted.
   *
   * Clamped to 0.99 max because `bytesSeen` can exceed `usedBytes`
   * slightly on filesystems where free-space accounting and summed
   * file sizes diverge (NTFS sparse / hardlinked files, metadata
   * overhead). Showing "103% scanned" reads as broken — 99% at most
   * until the Done snapshot arrives.
   */
  const scanProgressFraction = useCallback(
    (snap: ScanSnapshot): number | null => {
      if (snap.status !== "running" || !snap.rootPath) {
        return null;
      }
      // Finalizing phase: scanner has stopped walking, is now writing
      // the folder-tree sidecar + flushing the index. Return null so
      // the drive pill / stripe go indeterminate instead of sitting at
      // the misleading "98%" the previous run ended on.
      if (snap.scanPhase === "finalizing") {
        return null;
      }
      // During the indexing phase the scanner pre-sorts records
      // biggest-first, so bytes saturate the progress near 100% while
      // millions of small files are still streaming. Prefer a
      // files-based fraction here so the drive pill, scan stripe, and
      // header PROGRESS metric all track the same linear thing. Falls
      // back to bytes-based when expected file count isn't known (walker
      // path or pre-indexing phases).
      if (
        snap.scanPhase === "indexing"
        && typeof snap.expectedTotalFiles === "number"
        && snap.expectedTotalFiles > 0
      ) {
        const frac = snap.filesVisited / snap.expectedTotalFiles;
        if (!Number.isFinite(frac)) return null;
        return Math.min(0.99, Math.max(0, frac));
      }
      if (snap.bytesSeen <= 0) return null;
      const drive = drives.find((d) =>
        snap.rootPath!.toLowerCase().startsWith(d.drive.toLowerCase()),
      );
      if (!drive || !drive.usedBytes || drive.usedBytes <= 0) return null;
      const raw = snap.bytesSeen / drive.usedBytes;
      if (!Number.isFinite(raw)) return null;
      return Math.min(0.99, Math.max(0, raw));
    },
    [drives],
  );

  const currentScanPercent = useMemo(() => {
    const frac = scanProgressFraction(snapshot);
    return frac === null ? null : Math.round(frac * 100);
  }, [snapshot, scanProgressFraction]);

  const applyResolvedTheme = useCallback((resolved: "dark" | "light") => {
    const root = document.documentElement;
    root.classList.remove("light", "dark");
    if (resolved === "light") root.classList.add("light");
    nativeApi.applyTheme(resolved);
    setActiveTheme(resolved);
  }, []);

  // Apply color-blind mode globally: toggles the .colorblind class on
  // <html> (CSS variables kick in from index.css) AND flips the JS
  // palette flags for treemap extension colors + process treemap hash
  // colors. Done as one operation so the user never sees a half-swapped
  // UI mid-save.
  const applyColorBlindMode = useCallback((on: boolean) => {
    document.documentElement.classList.toggle("colorblind", on);
    setColorBlindPalette(on);
    setProcessPaletteColorBlind(on);
  }, []);

  const syncThemePreference = useCallback((theme: GeneralSettings["theme"]) => {
    setThemePreference(theme);
    applyResolvedTheme(resolveThemePreference(theme));
  }, [applyResolvedTheme]);

  // Load and apply theme + accessibility options on mount.
  useEffect(() => {
    void nativeApi.getSettings().then((s) => {
      if (!s) return;
      syncThemePreference(s.general.theme);
      applyColorBlindMode(Boolean(s.general.colorBlindMode));
    });
  }, [syncThemePreference, applyColorBlindMode]);

  useEffect(() => {
    const root = document.documentElement;
    const platformClass = resolvePlatformClass();
    root.classList.remove("platform-windows", "platform-macos", "platform-linux");
    root.classList.add(platformClass);
    return () => {
      root.classList.remove(platformClass);
    };
  }, []);

  // Forward renderer-side errors to the main process so they land in
  // crash.log alongside main-process exceptions. Without this, any
  // uncaught exception or promise rejection in the UI was lost once
  // the DevTools console was closed.
  useEffect(() => {
    const onError = (event: ErrorEvent) => {
      nativeApi.reportRendererError({
        message: event.message,
        stack: event.error?.stack,
        source: event.filename ? `${event.filename}:${event.lineno}:${event.colno}` : undefined,
      });
    };
    const onRejection = (event: PromiseRejectionEvent) => {
      const reason = event.reason;
      nativeApi.reportRendererError({
        message: reason instanceof Error ? reason.message : `Unhandled rejection: ${String(reason)}`,
        stack: reason instanceof Error ? reason.stack : undefined,
      });
    };
    window.addEventListener("error", onError);
    window.addEventListener("unhandledrejection", onRejection);
    return () => {
      window.removeEventListener("error", onError);
      window.removeEventListener("unhandledrejection", onRejection);
    };
  }, []);

  // Keep "System" theme in sync with OS changes while the app is open.
  useEffect(() => {
    if (themePreference !== "system") {
      return;
    }

    const media = window.matchMedia("(prefers-color-scheme: light)");
    const handleChange = (event: MediaQueryListEvent) => {
      applyResolvedTheme(event.matches ? "light" : "dark");
    };

    if (typeof media.addEventListener === "function") {
      media.addEventListener("change", handleChange);
      return () => media.removeEventListener("change", handleChange);
    }

    media.addListener(handleChange);
    return () => media.removeListener(handleChange);
  }, [themePreference, applyResolvedTheme]);

  // Renderer-local settings sync for theme and other reactive view state.
  useEffect(() => {
    const handleSettings = (event: Event) => {
      const detail = (event as CustomEvent<AppSettings>).detail;
      if (detail) {
        syncThemePreference(detail.general.theme);
        applyColorBlindMode(Boolean(detail.general.colorBlindMode));
      }
    };

    window.addEventListener(SETTINGS_UPDATED_EVENT, handleSettings as EventListener);
    return () => {
      window.removeEventListener(SETTINGS_UPDATED_EVENT, handleSettings as EventListener);
    };
  }, [syncThemePreference, applyColorBlindMode]);

  // Boot: load current snapshot + drives + IPC listeners (run once).
  //
  // Gate `showPicker = false` on the snapshot having a real rootPath —
  // a rehydrated "done" snapshot with a null rootPath would otherwise
  // hide the DiskPicker and leave the user staring at an empty Overview
  // with "No scan root selected" in the status bar, which has happened
  // in the wild when the stored last-scan.json drifted from the current
  // schema.
  useEffect(() => {
    void nativeApi.getCurrentSnapshot().then((s) => {
      const hasUsefulRoot = Boolean(s?.rootPath);
      const hasActivity = s && (s.status === "running" || s.status === "done");
      if (s && hasActivity && hasUsefulRoot) {
        syncSnapshot(s);
        setShowPicker(false);
      } else {
        if (s && hasUsefulRoot) syncSnapshot(s);
        setShowPicker(true);
      }
    });
    void nativeApi.getDiskSpace().then((d) => { if (d) setDrives(d); });
    // Seed the active-scan set so the UI's drive-pill progress
    // indicators reflect scans that were already running when the
    // renderer mounted (typical after a reload during a scheduled scan).
    void nativeApi.getActiveScanRoots().then((roots) => {
      if (!roots) return;
      setActiveScanKeys(new Set(roots.map(rootKey)));
    });

    // Track a deduped set of "scan completion" toasts — the user was
    // seeing duplicates because the IPC listener fires once per done
    // snapshot AND we have multiple consumers that each reacted. With
    // per-root state, we only toast the first "done" we see for a
    // given (root, finishedAt) pair.
    const toastedCompletions = new Set<string>();

    const unsub = nativeApi.onScanSnapshot((s) => {
      // Route the snapshot to its root in the map — DON'T steal the
      // user's currently-viewed root. If they're scanning C: and looking
      // at D:'s history, C:'s progress still streams in behind the
      // scenes without hijacking the view. Explicit doScan() and drive
      // clicks are the only things that change currentRoot.
      storeSnapshot(s);

      if (!s.rootPath) return;
      const key = rootKey(s.rootPath);

      if (s.status === "running") {
        setActiveScanKeys((prev) => new Set(prev).add(key));
        setShowPicker(false);
      }

      if (s.status === "done" || s.status === "cancelled" || s.status === "error") {
        setActiveScanKeys((prev) => {
          const next = new Set(prev);
          next.delete(key);
          return next;
        });
      }

      if (s.status === "done") {
        const dedupeKey = `${key}:${s.finishedAt ?? 0}`;
        if (toastedCompletions.has(dedupeKey)) return;
        toastedCompletions.add(dedupeKey);
        // Cap memory — toast-dedupe set only cares about recent scans.
        if (toastedCompletions.size > 20) {
          const first = toastedCompletions.values().next().value;
          if (first) toastedCompletions.delete(first);
        }

        // Refresh drives after scan
        void nativeApi.getDiskSpace().then((d) => { if (d) setDrives(d); });
        // Check for a diff against the previous scan
        if (s.rootPath) {
          void nativeApi.getLatestDiff(s.rootPath).then((diff) => {
            if (diff && diff.totalBytesDelta !== 0) {
              setHasPendingDiff(true);
              const gained = diff.totalBytesDelta > 0;
              const verb = gained ? "grew" : "freed";
              const absBytes = formatBytes(Math.abs(diff.totalBytesDelta));
              toast(
                gained ? "warning" : "success",
                `${absBytes} ${verb} since last scan`,
                "Switch to the Changes tab to see details.",
              );
            }
          });
        }
      }
    });

    const unsubUpdate = nativeApi.onUpdateStatus((status) => {
      setUpdateStatus(status);
    });

    // System-Widget click-throughs: the widget's hero tiles + sections fire
    // `focusMainWithView` IPC, which the main process forwards here as a
    // navigate push. Set the active root first (if specified) so a click on
    // the widget's "C:" drive row drops the user into Overview pre-pointed
    // at C:; then switch the tab. Skip the picker — user's intent was to
    // see this view immediately, not pick a drive.
    const unsubNavigate = nativeApi.onNavigateView(({ view, scanRoot }) => {
      if (scanRoot) {
        setCurrentRoot(scanRoot);
      }
      setShowPicker(false);
      setView(view);
    });

    // ── Duplicate scan IPC wiring ──
    // Seed: an in-progress scan kicked off before the renderer mounted (or
    // before a tab-switch remounted App) should still show as active.
    void nativeApi.getActiveDuplicateScanRoots().then((roots) => {
      if (!roots) return;
      setActiveDuplicateKeys(new Set(roots.map(rootKey)));
    });

    const unsubDupProgress = nativeApi.onDuplicateProgress((p) => {
      if (!p.rootPath) return;
      const key = rootKey(p.rootPath);
      setDuplicateProgressByRoot((prev) => {
        const next = new Map(prev);
        next.set(key, p);
        return next;
      });
      // Stream confirmed groups into the per-root analyses map as
      // they're emitted by the scanner. Without this, all 2000+
      // groups land in one flood at scan-end; users stared at the
      // progress bar for 30+ minutes before seeing any of their
      // biggest wasted-space finds. Now the list populates live.
      if (p.newGroups && p.newGroups.length > 0) {
        setDuplicateAnalysesByRoot((prev) => {
          const next = new Map(prev);
          const existing = next.get(key);
          const combinedGroups = existing?.groups
            ? [...existing.groups, ...p.newGroups!]
            : [...p.newGroups!];
          // Running totals so the UI header shows live counts;
          // finalised at scan-end via onDuplicateResult.
          const totalWastedBytes = combinedGroups.reduce(
            (sum, g) => sum + (g.files.length - 1) * g.size,
            0,
          );
          const totalDuplicateFiles = combinedGroups.reduce(
            (sum, g) => sum + g.files.length,
            0,
          );
          next.set(key, {
            groups: combinedGroups,
            totalWastedBytes,
            totalGroups: combinedGroups.length,
            totalDuplicateFiles,
            rootPath: p.rootPath,
            filesWalked: p.filesWalked,
            filesHashed: p.filesHashed,
            elapsedMs: p.elapsedMs,
            analyzedAt: existing?.analyzedAt ?? Date.now(),
          });
          return next;
        });
      }
      // Walking/hashing = active; done/cancelled/error = inactive.
      const isActive = p.status === "walking" || p.status === "hashing";
      setActiveDuplicateKeys((prev) => {
        const next = new Set(prev);
        if (isActive) next.add(key);
        else next.delete(key);
        return next;
      });
    });

    const unsubDupResult = nativeApi.onDuplicateResult((result) => {
      if (!result.rootPath) return;
      const key = rootKey(result.rootPath);
      setDuplicateAnalysesByRoot((prev) => {
        const next = new Map(prev);
        next.set(key, result);
        return next;
      });
      setDuplicateProgressByRoot((prev) => {
        const next = new Map(prev);
        next.delete(key);
        return next;
      });
      setActiveDuplicateKeys((prev) => {
        const next = new Set(prev);
        next.delete(key);
        return next;
      });
    });

    // EasyMove live progress — cross-drive copies of large files
    // can take tens of seconds. We show a single upsert-by-id
    // toast per operation that updates in place as bytes stream,
    // and auto-dismisses on the final "done" phase.
    const unsubEasyMoveProgress = nativeApi.onEasyMoveProgress((p) => {
      const name = p.sourcePath.split(/[\\/]/).pop() ?? p.sourcePath;
      const toastId = `easy-move:${p.sourcePath}`;
      if (p.phase === "done") {
        // Don't spam a "done" toast — the final success/error toast
        // from easyMove's return value handles the completion UI.
        // Just dismiss the progress entry so it doesn't linger.
        dismissToast(toastId);
        return;
      }
      const pct =
        p.bytesTotal > 0
          ? Math.min(100, Math.round((p.bytesCopied / p.bytesTotal) * 100))
          : 0;
      const copied = formatBytes(p.bytesCopied);
      const total = formatBytes(p.bytesTotal);
      toast(
        "info",
        p.phase === "linking" ? `Linking ${name}…` : `Moving ${name}`,
        `${copied} / ${total} (${pct}%)`,
        { id: toastId, dismissAfterMs: 0 },
      );
    });

    return () => {
      unsub();
      unsubUpdate();
      unsubNavigate();
      unsubDupProgress();
      unsubDupResult();
      unsubEasyMoveProgress();
    };
  }, []);

  // Keyboard shortcuts (separate effect so search state changes don't tear down IPC listeners)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey) {
        if (e.shiftKey && e.key.toLowerCase() === "w") {
          e.preventDefault();
          void nativeApi.openSystemWidget();
          return;
        }
        const tab = TABS.find((t) => t.key === e.key);
        if (tab) { e.preventDefault(); setView(tab.id); }
        // Ctrl+F to open search
        if (e.key === "f") {
          e.preventDefault();
          if (showPicker) return;
          if (!SEARCHABLE_VIEWS.includes(view)) {
            setFilterExt(undefined);
            setView("files");
          }
          setSearchOpen(true);
        }
      }
      // Escape to close search
      if (e.key === "Escape" && searchOpen) {
        setSearchOpen(false);
        setSearchQuery("");
      }
      // ? (Shift+/) to toggle the shortcut help overlay — but not while
      // typing in an input or text area.
      if (e.key === "?" && !isEditableElement(e.target)) {
        e.preventDefault();
        setShortcutHelpOpen((v) => !v);
      }
    };
    window.addEventListener("keydown", onKey);

    return () => { window.removeEventListener("keydown", onKey); };
  }, [searchOpen, showPicker, view]);

  useEffect(() => {
    if (!isSearchableView && searchOpen) {
      setSearchOpen(false);
      setSearchQuery("");
    }
  }, [isSearchableView, searchOpen]);

  /**
   * Store a snapshot under its rootPath. Never changes which root the UI
   * is currently viewing — that's up to the caller (drive-chip click,
   * explicit scan, etc.). This routes incoming IPC broadcasts and
   * history-restored snapshots both, so the UI stays consistent whether
   * the update came from a live scan or a background load.
   */
  const storeSnapshot = useCallback((s: ScanSnapshot) => {
    if (!s.rootPath) return;
    const key = rootKey(s.rootPath);
    setSnapshotsByRoot((prev) => {
      const next = new Map(prev);
      next.set(key, s);
      return next;
    });
    setScanOptions(s.scanOptions);
  }, []);

  /**
   * Set both the stored snapshot AND the currently-viewed root. Used
   * whenever we want to navigate the UI to a specific scan state (e.g.
   * after the user explicitly clicks "Rescan" or starts a new scan).
   */
  const syncSnapshot = useCallback((s: ScanSnapshot) => {
    storeSnapshot(s);
    if (s.rootPath) setCurrentRoot(s.rootPath);
  }, [storeSnapshot]);

  const pickAndScan = async () => {
    const picked = await nativeApi.pickRootPath();
    if (!picked) return;
    setRootPath(picked);
    await doScan(picked);
  };

  const doScan = async (path = rootPath) => {
    if (!path.trim()) {
      toast("warning", "Choose a folder first");
      return;
    }
    setShowPicker(false);
    // Synthesize a running-status placeholder immediately so the UI
    // doesn't flash the "No scan data for X\" idle CTA while the native
    // scanner spawns (takes ~100-500ms to return its first snapshot).
    // The real running snapshot from startScan will replace this as
    // soon as it arrives.
    const trimmed = path.trim();
    syncSnapshot({
      ...createIdleScanSnapshot(),
      status: "running",
      rootPath: trimmed,
      startedAt: Date.now(),
      lastUpdatedAt: Date.now(),
    });
    const s = await nativeApi.startScan(trimmed, scanOptions);
    syncSnapshot(s);
  };

  /**
   * Drive-pill click. Switches the viewed root without triggering a
   * scan — the user sees whatever's known about that drive (fresh
   * snapshot if one exists in memory, otherwise the most recent saved
   * snapshot from history). An empty state with a CTA is shown if
   * nothing's been scanned yet. Users explicitly kick off a scan via
   * "Rescan" or "New Scan".
   *
   * Rationale: the old behavior silently restarted a scan on every
   * drive click, which wiped running state and triggered duplicate
   * scan-complete toasts when users switched around.
   */
  const handleScanDrive = async (drivePath: string) => {
    // Normalize "C:" → "C:\\" so Path.resolve doesn't use CWD
    const normalized = /^[A-Za-z]:$/.test(drivePath) ? drivePath + "\\" : drivePath;
    setCurrentRoot(normalized);
    setShowPicker(false);

    const key = rootKey(normalized);
    // If we already have a snapshot for this root in memory, we're done —
    // the derived `snapshot` will pick it up from snapshotsByRoot.
    if (snapshotsByRoot.has(key)) return;

    // If there's a live scan already running for this root, DON'T load the
    // stale historical snapshot — the running scan will stream its own
    // snapshots in via the onScanSnapshot listener within a beat. Loading
    // history here caused a visible "shift" 10–20s later when the live
    // snapshot arrived with different top-N data and the treemap
    // relaid-out underneath the user.
    if (activeScanKeys.has(key)) return;

    // Drop a synthetic "running" placeholder SYNCHRONOUSLY before any
    // await. Without this, the render pass between setCurrentRoot and
    // doScan's own placeholder flashes the "No scan data for X\" empty
    // state for a few ms — visible as UI jank on every drive click.
    // The placeholder immediately puts the UI in Scanning mode; the
    // real first snapshot from the scanner replaces it ~100-300 ms later.
    syncSnapshot({
      ...createIdleScanSnapshot(),
      status: "running",
      rootPath: normalized,
      startedAt: Date.now(),
      lastUpdatedAt: Date.now(),
    });

    // Otherwise, try to restore the latest saved snapshot from history.
    const latest = await nativeApi.getLatestSnapshotForRoot(normalized);
    if (latest) {
      storeSnapshot(latest);
      return;
    }
    // No historical data either — this drive has never been scanned.
    // Auto-kick a scan instead of landing the user on a dead-end empty
    // state with a "hit Rescan in the header" instruction. The
    // anti-auto-scan comment above applies only to *switching between*
    // already-scanned drives, not to first-ever selection.
    await doScan(normalized);
  };

  const handleScanFolder = (folderPath: string) => {
    setRootPath(folderPath);
    void doScan(folderPath);
  };

  const openPicker = () => setShowPicker(true);

  const cancelScan = async () => {
    // Cancel the scan for the currently-viewed root. Other drives'
    // scans keep running — that's what the per-root refactor unlocks.
    const s = await nativeApi.cancelScan(currentRoot || undefined);
    if (s) storeSnapshot(s);
    toast("info", "Scan stopped", "Current results are still usable.");
  };

  const onFilterExtension = (ext: string) => {
    setFilterExt(ext);
    setView("files");
  };

  // Search: filter the file list. Folders and extensions come from full scan
  // data (directory rollups) so they aren't filtered — only the file-level
  // views (Largest Files, Overview treemap) respond to search.
  const searchFilteredSnapshot = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return snapshot;
    return {
      ...snapshot,
      largestFiles: snapshot.largestFiles.filter(
        (f) =>
          f.path.toLowerCase().includes(q) ||
          f.name.toLowerCase().includes(q) ||
          f.extension.toLowerCase().includes(q),
      ),
    };
  }, [snapshot, searchQuery]);

  const statusLabel = useMemo(() => {
    switch (snapshot.status) {
      case "running":
        // Differentiate the last 30-60s of a scan — the scanner has
        // stopped walking and is writing the folder-tree sidecar +
        // flushing the gzipped index. Without this the top-bar label
        // said "Scanning" for a full minute after the progress bar
        // hit 100%, which looked stuck to the user.
        if (snapshot.scanPhase === "finalizing") return "Finalizing";
        if (snapshot.scanPhase === "reading_metadata") return "Reading metadata";
        return "Scanning";
      case "done": return "Complete";
      case "cancelled": return "Stopped";
      case "error": return "Error";
      default: return "Ready";
    }
  }, [snapshot.status, snapshot.scanPhase]);

  return (
    <ToastProvider>
      <div className="app-shell">
        {/* Scan progress stripe */}
        {/* Scan stripe — pulses (indeterminate) during the early
         * baseline-load / first-file phase, then converts to a real
         * progress fill the moment we have a bytesSeen-vs-usedBytes
         * ratio we can trust. */}
        <div className={`scan-stripe ${snapshot.status === "running" ? "active" : ""} ${currentScanPercent !== null ? "determinate" : ""}`}>
          {currentScanPercent !== null && (
            <div
              className="scan-stripe-fill"
              style={{ width: `${currentScanPercent}%` }}
              aria-valuenow={currentScanPercent}
              aria-valuemin={0}
              aria-valuemax={100}
              role="progressbar"
            />
          )}
        </div>

        {/* Admin banner — shown once to users who aren't running
         *  elevated. MFT fast-scans require admin, and non-elevated
         *  users fall back to the 10-20× slower FindFirstFile walker
         *  without ever knowing the fast path existed. Dismissed
         *  permanently via localStorage once the user engages (or
         *  explicitly dismisses).
         *
         *  Windows-only: MFT doesn't exist on macOS/Linux. The banner
         *  is already implicitly suppressed there because the
         *  `isElevated()` stub returns true outside Windows, but an
         *  explicit platform guard keeps it that way if the stub ever
         *  changes (and makes the intent readable). */}
        {nativeApi.platform === "win32"
          && elevationStatus
          && !elevationStatus.elevated
          && !elevationStatus.scheduledTaskRegistered
          && !adminBannerDismissed
          && (
            <div className="admin-banner">
              <span className="admin-banner-icon">⚡</span>
              <span className="admin-banner-text">
                Run scans <strong>10-20× faster</strong> on NTFS drives with admin rights.
              </span>
              <button
                className="admin-banner-btn-secondary"
                onClick={async () => {
                  // Permanent opt-in: one UAC prompt now to register the
                  // Scheduled Task; future launches via shortcut auto-
                  // elevate with no further prompts.
                  const result = await nativeApi.registerScheduledTask();
                  if (result.ok) {
                    toast(
                      "success",
                      "Fast scans enabled",
                      "Future launches will auto-elevate with no UAC prompt.",
                    );
                    dismissAdminBanner();
                    // Relaunch via the newly-registered task so the user
                    // starts getting the speedup immediately.
                    await nativeApi.runScheduledTask();
                  } else {
                    toast(
                      "error",
                      "Couldn't enable fast scans",
                      "UAC was likely cancelled. Try again from Settings → Performance.",
                    );
                  }
                }}
                title="One UAC prompt now → zero UAC prompts forever"
              >
                Always (recommended)
              </button>
              <button
                className="admin-banner-btn"
                onClick={async () => {
                  const result = await nativeApi.relaunchAsAdmin();
                  if (!result.ok) {
                    toast("error", result.message ?? "Couldn't relaunch as admin");
                  }
                }}
                title="Elevate this session only — UAC prompts again next launch"
              >
                Just this time
              </button>
              <button
                className="admin-banner-dismiss"
                onClick={dismissAdminBanner}
                title="Dismiss (re-enable in Settings → Performance)"
              >
                &times;
              </button>
            </div>
          )}

        {/* Update banner — shows when an update is downloaded and ready */}
        {updateStatus?.phase === "downloaded" && (
          <div className="update-banner">
            <span className="update-banner-icon">↻</span>
            <span className="update-banner-text">
              DiskHound <strong>v{updateStatus.availableVersion}</strong> is ready to install.
            </span>
            <button className="update-banner-btn" onClick={() => nativeApi.quitAndInstall()}>
              Restart & install
            </button>
            <button className="update-banner-dismiss" onClick={() => setUpdateStatus(null)} title="Dismiss">&times;</button>
          </div>
        )}

        {/* ── Header ── */}
        <header className="header">
          <div className="header-brand">
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
              <rect x="1" y="1" width="14" height="14" rx="2" stroke="currentColor" strokeWidth="1.5" />
              <rect x="4" y="4" width="4" height="4" fill="currentColor" opacity="0.8" />
              <rect x="9" y="4" width="3" height="8" fill="currentColor" opacity="0.5" />
              <rect x="4" y="9" width="4" height="3" fill="currentColor" opacity="0.3" />
            </svg>
            DiskHound
          </div>

          <div className="scan-controls">
            <input
              className="scan-input"
              value={rootPath}
              onInput={(e) => setRootPath((e.target as HTMLInputElement).value)}
              placeholder={scanInputPlaceholder()}
              onKeyDown={(e) => { if (e.key === "Enter") void doScan(); }}
            />
            {snapshot.status === "running" ? (
              <button
                className="scan-btn scan-btn-stop"
                onClick={() => void cancelScan()}
                title={`Stop the scan on ${rootPath || "this root"} (other drives keep running)`}
              >
                Stop
              </button>
            ) : rootPath ? (
              <>
                {/* When a root is selected, Rescan is the primary action —
                 * re-scans this drive/folder. The "+" satellite button
                 * starts a brand-new scan on a different path without
                 * disturbing the current one (they run in parallel).
                 *
                 * Rationale: the prior UI had both "New Scan" and "Rescan"
                 * as full-width buttons which took up header room and
                 * were easily confused — users reported clicking "New Scan"
                 * expecting Rescan behavior. */}
                <button
                  className="scan-btn scan-btn-primary"
                  onClick={() => void doScan()}
                  title={`Rescan ${rootPath}`}
                >
                  Rescan
                </button>
                <button
                  className="scan-btn scan-btn-icon"
                  onClick={openPicker}
                  title="Scan a different drive or folder (runs in parallel)"
                  aria-label="Scan another drive or folder"
                >
                  <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round">
                    <path d="M6 2V10M2 6H10" />
                  </svg>
                </button>
              </>
            ) : (
              // No root selected yet → only the picker is meaningful.
              <button
                className="scan-btn scan-btn-primary"
                onClick={openPicker}
                title="Pick a drive or folder to scan"
              >
                New Scan
              </button>
            )}
          </div>

          <div className="drive-pills">
            {drives.map((d) => {
              // A drive is "scanning" if ANY active-scan root starts with
              // its letter — catches both `C:\` root scans and scans of
              // sub-paths like `C:\Users\foo`.
              const driveLetterPrefix = d.drive.toLowerCase().replace(/:?\\?$/, "");
              const isScanning = Array.from(activeScanKeys).some((key) =>
                key.startsWith(driveLetterPrefix),
              );
              // When this drive IS the one currently being scanned (it
              // matches the viewed root's drive letter AND we have live
              // progress), show the percent so the user can eye pace
              // across multiple parallel scans.
              const sharesRootLetter = rootPath
                .toLowerCase()
                .startsWith(d.drive.toLowerCase());
              const pillScanPercent =
                isScanning && sharesRootLetter ? currentScanPercent : null;
              return (
                <DrivePill
                  key={d.drive}
                  drive={d}
                  active={sharesRootLetter}
                  scanning={isScanning}
                  scanPercent={pillScanPercent}
                  onScan={() => void handleScanDrive(d.drive)}
                />
              );
            })}
          </div>

          {/* Utility buttons grouped behind a visual divider so they
           *  read as a separate region from the drive pills. The
           *  group keeps a tighter 4 px internal gap (vs. the
           *  header's 12 px) so the three icons share visual
           *  weight without stealing horizontal real estate from
           *  the pills next to them. */}
          <div className="header-utilities">
            {/* Search toggle */}
            <button
              className={`header-icon-btn ${searchOpen ? "active" : ""}`}
              onClick={() => {
                if (showPicker) return;
                if (!isSearchableView) {
                  setFilterExt(undefined);
                  setView("files");
                  setSearchOpen(true);
                  return;
                }
                setSearchOpen(!searchOpen);
                if (searchOpen) setSearchQuery("");
              }}
              title="Search largest files (Ctrl+F)"
            >
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.3">
                <circle cx="6" cy="6" r="4" />
                <path d="M9.5 9.5L12.5 12.5" />
              </svg>
            </button>

            {/* System Widget. Picture-in-Picture-style glyph
             *  (filled sub-window inside an outer window outline)
             *  is the universal "open as a floating window" affordance,
             *  the same shape Apple, YouTube, and most video apps
             *  use for PiP. The previous icon (rect with content
             *  rows) read as "settings panel" / "document" rather
             *  than "detach to floating monitor." */}
            <button className="header-icon-btn" onClick={() => void nativeApi.openSystemWidget()} title="Open system widget (Ctrl+Shift+W)">
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round">
                <rect x="1.5" y="2.5" width="11" height="9" rx="1.4" />
                <rect x="6.5" y="6.5" width="5" height="4" rx="0.8" fill="currentColor" stroke="none" />
              </svg>
            </button>

            <button className="header-icon-btn" onClick={() => { setShowPicker(false); setView("settings"); }} title="Settings">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
                <circle cx="12" cy="12" r="3" />
              </svg>
            </button>
          </div>
        </header>

        {/* ── Search bar (slides in) ── */}
        {searchOpen && !showPicker && isSearchableView && (
          <div className="search-bar">
            <svg className="search-bar-icon" width="13" height="13" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.3">
              <circle cx="6" cy="6" r="4" />
              <path d="M9.5 9.5L12.5 12.5" />
            </svg>
            <input
              className="search-bar-input"
              value={searchQuery}
              onInput={(e) => setSearchQuery((e.target as HTMLInputElement).value)}
              placeholder="Filter largest files by name, path, or extension..."
              autoFocus
            />
            {searchQuery && (
              <span className="search-bar-count">
              {searchFilteredSnapshot.largestFiles.length} match{searchFilteredSnapshot.largestFiles.length !== 1 ? "es" : ""}
            </span>
          )}
            <button
              className="search-bar-close"
              onClick={() => { setSearchOpen(false); setSearchQuery(""); }}
            >
              <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.5">
                <path d="M2 2L8 8M8 2L2 8" />
              </svg>
            </button>
          </div>
        )}

        {/* ── Tab Bar ── */}
        <nav className="tab-bar">
          {TABS.map((tab) => (
            <button
              key={tab.id}
              className={`tab-btn ${view === tab.id ? "active" : ""}`}
              onClick={() => {
                setView(tab.id);
                if (snapshot.status !== "idle") setShowPicker(false);
                if (tab.id !== "files") setFilterExt(undefined);
                if (!SEARCHABLE_VIEWS.includes(tab.id)) {
                  setSearchOpen(false);
                  setSearchQuery("");
                }
                if (tab.id === "changes") setHasPendingDiff(false);
              }}
            >
              {tab.label}
              {tab.id === "changes" && hasPendingDiff && view !== "changes" && (
                <span className="tab-badge" />
              )}
            </button>
          ))}
          <div className="tab-spacer" />
          <div className="tab-status">
            <span className={`status-dot ${snapshot.status}`} />
            <span>{statusLabel}</span>
            {snapshot.status === "running" && (
              <>
                <span>&middot;</span>
                <span className="scan-progress-ticker">
                  {snapshot.filesVisited > 0
                    ? `${snapshot.filesVisited.toLocaleString()} files · ${formatBytes(snapshot.bytesSeen)}${currentScanPercent !== null ? ` · ${currentScanPercent}%` : ""}`
                    : "preparing…"}
                </span>
              </>
            )}
          </div>
        </nav>

        {/* ── Main View ── */}
        <div className="view-container">
          {showPicker === null ? <StartupSplash /> : showPicker && view !== "memory" && view !== "diskIo" && view !== "settings" ? (
            <DiskPicker
              onScanDrive={handleScanDrive}
              onScanFolder={handleScanFolder}
            />
          ) : (
            <>
              {view === "overview" && <ErrorBoundary name="Overview"><Overview snapshot={snapshot} onFilterExtension={onFilterExtension} scanPercent={currentScanPercent} /></ErrorBoundary>}
              {view === "files" && <ErrorBoundary name="File List"><FileList snapshot={searchFilteredSnapshot} initialFilter={filterExt} /></ErrorBoundary>}
              {view === "folders" && <ErrorBoundary name="Folders"><FolderList snapshot={snapshot} /></ErrorBoundary>}
              {view === "duplicates" && (
                <ErrorBoundary name="Duplicates">
                  <DuplicatesView
                    snapshot={snapshot}
                    analysis={duplicateAnalysesByRoot.get(rootKey(snapshot.rootPath)) ?? null}
                    progress={duplicateProgressByRoot.get(rootKey(snapshot.rootPath)) ?? null}
                    isScanning={activeDuplicateKeys.has(rootKey(snapshot.rootPath))}
                    onClearAnalysis={(root) => {
                      const key = rootKey(root);
                      setDuplicateAnalysesByRoot((prev) => {
                        if (!prev.has(key)) return prev;
                        const next = new Map(prev);
                        next.delete(key);
                        return next;
                      });
                    }}
                  />
                </ErrorBoundary>
              )}
              {view === "changes" && <ErrorBoundary name="Changes"><ChangesView rootPath={snapshot.rootPath} snapshot={snapshot} /></ErrorBoundary>}
              {view === "easyMove" && <ErrorBoundary name="Easy Move"><EasyMoveView /></ErrorBoundary>}
              {view === "memory" && <ErrorBoundary name="Processes"><MemoryView /></ErrorBoundary>}
              {view === "diskIo" && <ErrorBoundary name="Disk I/O"><DiskIoView /></ErrorBoundary>}
              {view === "settings" && <ErrorBoundary name="Settings"><SettingsView /></ErrorBoundary>}
            </>
          )}
        </div>

        {/* ── Status Bar ── */}
        <footer className="status-bar">
          <span className="status-bar-path">{snapshot.rootPath ?? "No scan root selected"}</span>
          <span className="status-bar-spacer" />
          {snapshot.status !== "idle" && (
            <>
              <span className="status-bar-stat">{formatBytes(snapshot.bytesSeen)}</span>
              <span>&middot;</span>
              <span className="status-bar-stat">{snapshot.filesVisited.toLocaleString()} files</span>
              <span>&middot;</span>
              <span className="status-bar-stat">{snapshot.directoriesVisited.toLocaleString()} dirs</span>
              {currentScanPercent !== null && (
                <>
                  <span>&middot;</span>
                  <span className="status-bar-stat status-bar-scan-percent">
                    {currentScanPercent}% scanned
                  </span>
                </>
              )}
            </>
          )}
          {snapshot.errorMessage && (
            <span style={{ color: "var(--red)" }}>{snapshot.errorMessage}</span>
          )}
          <button
            className="status-bar-theme-toggle"
            onClick={() => {
              const next = cycleThemePreference(themePreference);
              syncThemePreference(next);
              void nativeApi.getSettings().then((s) => {
                if (!s) return;
                const nextSettings: AppSettings = {
                  ...s,
                  general: {
                    ...s.general,
                    theme: next,
                  },
                };
                void nativeApi.updateSettings(nextSettings).then(() => {
                  dispatchSettingsUpdated(nextSettings);
                });
              });
            }}
            title={`Theme: ${themePreference}. Click to switch to ${cycleThemePreference(themePreference)}.`}
          >
            {themePreference === "system" ? (
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <rect x="3" y="4" width="18" height="12" rx="2" />
                <path d="M8 20h8M12 16v4" />
              </svg>
            ) : activeTheme === "dark" ? (
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
              </svg>
            ) : (
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <circle cx="12" cy="12" r="5" />
                <path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42" />
              </svg>
            )}
            <span>{themePreference === "system" ? "System" : activeTheme === "dark" ? "Dark" : "Light"}</span>
          </button>
          <button
            className="status-bar-help"
            onClick={() => setShortcutHelpOpen(true)}
            title="Keyboard shortcuts (?)"
          >
            ?
          </button>
        </footer>

        <ShortcutHelp open={shortcutHelpOpen} onClose={() => setShortcutHelpOpen(false)} />
      </div>
    </ToastProvider>
  );
}

function DrivePill({ drive, active, scanning, scanPercent, onScan }: {
  drive: DiskSpaceInfo;
  active: boolean;
  scanning: boolean;
  scanPercent: number | null;
  onScan: () => void;
}) {
  const pct = drive.usedPercent;
  const level = pct > 90 ? "high" : pct > 70 ? "mid" : "low";
  const title = scanning
    ? `${drive.drive} — scanning${scanPercent !== null ? ` (${scanPercent}%)` : ""}. Click to view.`
    : `View ${drive.drive} (${formatBytes(drive.freeBytes)} free)`;

  return (
    <button
      className={`drive-pill ${active ? "drive-pill-active" : ""} ${scanning ? "drive-pill-scanning" : ""}`}
      onClick={onScan}
      title={title}
    >
      <span>{drive.drive}</span>
      <div className="drive-pill-bar">
        <div className={`drive-pill-fill ${level}`} style={{ width: `${pct}%` }} />
        {scanning && <div className="drive-pill-scan-pulse" aria-hidden="true" />}
        {/* When this drive's scan has a real percent, paint a thin
         * amber overlay at that width so the pill itself doubles as
         * a mini progress bar. Hidden when we're still indeterminate
         * so the pulse carries the "alive" signal alone. */}
        {scanning && scanPercent !== null && (
          <div
            className="drive-pill-scan-progress"
            style={{ width: `${scanPercent}%` }}
            aria-hidden="true"
          />
        )}
      </div>
      <span>
        {scanning && scanPercent !== null
          ? `${scanPercent}%`
          : `${formatBytes(drive.freeBytes)} free`}
      </span>
    </button>
  );
}
