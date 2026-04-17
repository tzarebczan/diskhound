import { useCallback, useEffect, useMemo, useState } from "preact/hooks";

import {
  type AppSettings,
  createIdleScanSnapshot,
  defaultScanOptions,
  type AppView,
  type DiskSpaceInfo,
  type GeneralSettings,
  type ScanOptions,
  type ScanSnapshot,
  type UpdateStatus,
} from "../shared/contracts";
import { formatBytes } from "./lib/format";
import { dispatchSettingsUpdated, SETTINGS_UPDATED_EVENT } from "./lib/uiEvents";
import { nativeApi } from "./nativeApi";

import { ChangesView } from "./components/ChangesView";
import { DiskPicker } from "./components/DiskPicker";
import { DuplicatesView } from "./components/DuplicatesView";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { EasyMoveView } from "./components/EasyMoveView";
import { FileList } from "./components/FileList";
import { FolderList } from "./components/FolderList";
import { Overview } from "./components/Overview";
import { SettingsView } from "./components/SettingsView";
import { ToastProvider, toast } from "./components/Toasts";

const TABS: { id: AppView; label: string; key: string }[] = [
  { id: "overview", label: "Overview", key: "1" },
  { id: "files", label: "Largest Files", key: "2" },
  { id: "folders", label: "Folders", key: "3" },
  { id: "duplicates", label: "Duplicates", key: "4" },
  { id: "changes", label: "Changes", key: "5" },
  { id: "easyMove", label: "Easy Move", key: "6" },
  { id: "settings", label: "Settings", key: "7" },
];

const SEARCHABLE_VIEWS: readonly AppView[] = ["files"];

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

export function App() {
  const [snapshot, setSnapshot] = useState<ScanSnapshot>(createIdleScanSnapshot());
  const [rootPath, setRootPath] = useState("");
  const [scanOptions, setScanOptions] = useState<ScanOptions>(defaultScanOptions());
  const [view, setView] = useState<AppView>("overview");
  const [drives, setDrives] = useState<DiskSpaceInfo[]>([]);
  const [filterExt, setFilterExt] = useState<string | undefined>();
  const [showPicker, setShowPicker] = useState(true);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const [hasPendingDiff, setHasPendingDiff] = useState(false);
  const [activeTheme, setActiveTheme] = useState<"dark" | "light">("dark");
  const [themePreference, setThemePreference] = useState<GeneralSettings["theme"]>("dark");
  const [updateStatus, setUpdateStatus] = useState<UpdateStatus | null>(null);
  const isSearchableView = SEARCHABLE_VIEWS.includes(view);

  const applyResolvedTheme = useCallback((resolved: "dark" | "light") => {
    const root = document.documentElement;
    root.classList.remove("light", "dark");
    if (resolved === "light") root.classList.add("light");
    nativeApi.applyTheme(resolved);
    setActiveTheme(resolved);
  }, []);

  const syncThemePreference = useCallback((theme: GeneralSettings["theme"]) => {
    setThemePreference(theme);
    applyResolvedTheme(resolveThemePreference(theme));
  }, [applyResolvedTheme]);

  // Load and apply theme
  useEffect(() => {
    void nativeApi.getSettings().then((s) => {
      if (!s) return;
      syncThemePreference(s.general.theme);
    });
  }, [syncThemePreference]);

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
      }
    };

    window.addEventListener(SETTINGS_UPDATED_EVENT, handleSettings as EventListener);
    return () => {
      window.removeEventListener(SETTINGS_UPDATED_EVENT, handleSettings as EventListener);
    };
  }, [syncThemePreference]);

  // Boot: load current snapshot + drives + IPC listeners (run once)
  useEffect(() => {
    void nativeApi.getCurrentSnapshot().then((s) => {
      if (s) {
        syncSnapshot(s);
        // Hide picker if a scan is running or already completed
        if (s.status === "running" || s.status === "done") {
          setShowPicker(false);
        }
      }
    });
    void nativeApi.getDiskSpace().then((d) => { if (d) setDrives(d); });

    const unsub = nativeApi.onScanSnapshot((s) => {
      syncSnapshot(s);
      if (s.status === "running") {
        setShowPicker(false);
      }
      if (s.status === "done") {
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

    return () => { unsub(); unsubUpdate(); };
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

  const syncSnapshot = useCallback((s: ScanSnapshot) => {
    setSnapshot(s);
    if (s.rootPath) setRootPath(s.rootPath);
    setScanOptions(s.scanOptions);
  }, []);

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

  const handleScanDrive = (drivePath: string) => {
    // Normalize drive path: "C:" → "C:\" so Path.resolve doesn't use CWD
    const normalized = /^[A-Za-z]:$/.test(drivePath) ? drivePath + "\\" : drivePath;

    // If we already have a completed scan for this path, just switch to it
    if (snapshot.status === "done" && snapshot.rootPath === normalized) {
      setRootPath(normalized);
      setShowPicker(false);
      return;
    }

    setRootPath(normalized);
    void doScan(normalized);
  };

  const handleScanFolder = (folderPath: string) => {
    setRootPath(folderPath);
    void doScan(folderPath);
  };

  const openPicker = () => setShowPicker(true);

  const cancelScan = async () => {
    const s = await nativeApi.cancelScan();
    syncSnapshot(s);
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
              <button className="scan-btn scan-btn-stop" onClick={() => void cancelScan()}>
                Stop
              </button>
            ) : (
              <>
                <button className="scan-btn scan-btn-primary" onClick={openPicker}>
                  New Scan
                </button>
                {rootPath && (
                  <button className="scan-btn" onClick={() => void doScan()}>
                    Rescan
                  </button>
                )}
              </>
            )}
          </div>

          <div className="drive-pills">
            {drives.map((d) => (
              <DrivePill
                key={d.drive}
                drive={d}
                active={rootPath.toLowerCase().startsWith(d.drive.toLowerCase())}
                onScan={() => handleScanDrive(d.drive)}
              />
            ))}
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
                  {snapshot.filesVisited.toLocaleString()} files &middot; {formatBytes(snapshot.bytesSeen)}
                </span>
              </>
            )}
          </div>
        </nav>

        {/* ── Main View ── */}
        <div className="view-container">
          {showPicker ? (
            <DiskPicker
              onScanDrive={handleScanDrive}
              onScanFolder={handleScanFolder}
            />
          ) : (
            <>
              {view === "overview" && <ErrorBoundary name="Overview"><Overview snapshot={snapshot} onFilterExtension={onFilterExtension} /></ErrorBoundary>}
              {view === "files" && <ErrorBoundary name="File List"><FileList snapshot={searchFilteredSnapshot} initialFilter={filterExt} /></ErrorBoundary>}
              {view === "folders" && <ErrorBoundary name="Folders"><FolderList snapshot={snapshot} /></ErrorBoundary>}
              {view === "duplicates" && <ErrorBoundary name="Duplicates"><DuplicatesView snapshot={snapshot} /></ErrorBoundary>}
              {view === "changes" && <ErrorBoundary name="Changes"><ChangesView rootPath={snapshot.rootPath} snapshot={snapshot} /></ErrorBoundary>}
              {view === "easyMove" && <ErrorBoundary name="Easy Move"><EasyMoveView /></ErrorBoundary>}
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
        </footer>
      </div>
    </ToastProvider>
  );
}

function DrivePill({ drive, active, onScan }: { drive: DiskSpaceInfo; active: boolean; onScan: () => void }) {
  const pct = drive.usedPercent;
  const level = pct > 90 ? "high" : pct > 70 ? "mid" : "low";

  return (
    <button
      className={`drive-pill ${active ? "drive-pill-active" : ""}`}
      onClick={onScan}
      title={`Scan ${drive.drive} (${formatBytes(drive.freeBytes)} free)`}
    >
      <span>{drive.drive}</span>
      <div className="drive-pill-bar">
        <div className={`drive-pill-fill ${level}`} style={{ width: `${pct}%` }} />
      </div>
      <span>{formatBytes(drive.freeBytes)} free</span>
    </button>
  );
}
