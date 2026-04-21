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
import { MemoryView } from "./components/MemoryView";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { ShortcutHelp } from "./components/ShortcutHelp";
import { EasyMoveView } from "./components/EasyMoveView";
import { FileList } from "./components/FileList";
import { FolderList } from "./components/FolderList";
import { Overview } from "./components/Overview";
import { StartupSplash } from "./components/StartupSplash";
import { SettingsView } from "./components/SettingsView";
import { ToastProvider, toast } from "./components/Toasts";

const TABS: { id: AppView; label: string; key: string }[] = [
  { id: "overview", label: "Overview", key: "1" },
  { id: "files", label: "Largest Files", key: "2" },
  { id: "folders", label: "Folders", key: "3" },
  { id: "duplicates", label: "Duplicates", key: "4" },
  { id: "changes", label: "Changes", key: "5" },
  { id: "easyMove", label: "Easy Move", key: "6" },
  { id: "memory", label: "Processes", key: "7" },
  { id: "settings", label: "Settings", key: "8" },
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

/**
 * Normalize a root path for use as a snapshotsByRoot key. Case-insensitive
 * on Windows (where C:\ and c:\ are the same drive) and trims trailing
 * separators so "C:\\" and "C:\\Users\\..." collide correctly.
 */
function rootKey(rootPath: string | null | undefined): string {
  if (!rootPath) return "";
  return rootPath.replace(/[\\/]+$/, "").toLowerCase();
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
  const isSearchableView = SEARCHABLE_VIEWS.includes(view);

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

  // Boot: load current snapshot + drives + IPC listeners (run once)
  useEffect(() => {
    void nativeApi.getCurrentSnapshot().then((s) => {
      if (s && (s.status === "running" || s.status === "done")) {
        syncSnapshot(s);
        setShowPicker(false);
      } else {
        if (s) syncSnapshot(s);
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

    return () => {
      unsub();
      unsubUpdate();
      unsubDupProgress();
      unsubDupResult();
    };
  }, []);

  // Keyboard shortcuts (separate effect so search state changes don't tear down IPC listeners)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey) {
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
    const s = await nativeApi.startScan(path.trim(), scanOptions);
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

    // Otherwise, try to restore the latest saved snapshot from history.
    const latest = await nativeApi.getLatestSnapshotForRoot(normalized);
    if (latest) {
      storeSnapshot(latest);
    }
    // If neither fresh nor historical data exists, the derived snapshot
    // is the idle-with-rootPath stub set up in the snapshot useMemo,
    // which gives downstream views a proper empty state targeting this
    // drive rather than the old generic "no scan yet" UI.
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
      case "running": return "Scanning";
      case "done": return "Complete";
      case "cancelled": return "Stopped";
      case "error": return "Error";
      default: return "Ready";
    }
  }, [snapshot.status]);

  return (
    <ToastProvider>
      <div className="app-shell">
        {/* Scan progress stripe */}
        <div className={`scan-stripe ${snapshot.status === "running" ? "active" : ""}`} />

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
              placeholder="C:\Users\..."
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
              return (
                <DrivePill
                  key={d.drive}
                  drive={d}
                  active={rootPath.toLowerCase().startsWith(d.drive.toLowerCase())}
                  scanning={isScanning}
                  onScan={() => void handleScanDrive(d.drive)}
                />
              );
            })}
          </div>

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

          <button className="header-icon-btn" onClick={() => { setShowPicker(false); setView("settings"); }} title="Settings">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
              <circle cx="12" cy="12" r="3" />
            </svg>
          </button>
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
                    ? `${snapshot.filesVisited.toLocaleString()} files · ${formatBytes(snapshot.bytesSeen)}`
                    : "preparing…"}
                </span>
              </>
            )}
          </div>
        </nav>

        {/* ── Main View ── */}
        <div className="view-container">
          {showPicker === null ? <StartupSplash /> : showPicker && view !== "memory" && view !== "settings" ? (
            <DiskPicker
              onScanDrive={handleScanDrive}
              onScanFolder={handleScanFolder}
            />
          ) : (
            <>
              {view === "overview" && <ErrorBoundary name="Overview"><Overview snapshot={snapshot} onFilterExtension={onFilterExtension} /></ErrorBoundary>}
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

function DrivePill({ drive, active, scanning, onScan }: {
  drive: DiskSpaceInfo;
  active: boolean;
  scanning: boolean;
  onScan: () => void;
}) {
  const pct = drive.usedPercent;
  const level = pct > 90 ? "high" : pct > 70 ? "mid" : "low";
  const title = scanning
    ? `${drive.drive} — scanning in progress. Click to view.`
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
      </div>
      <span>{formatBytes(drive.freeBytes)} free</span>
    </button>
  );
}
