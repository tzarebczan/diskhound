import { useEffect, useMemo, useState } from "preact/hooks";

import type { ExtensionBucket, ScanFileRecord, ScanSnapshot } from "../../shared/contracts";
import { formatBytes, formatCount, formatElapsed, humanAge } from "../lib/format";
import { usePathActions, useSafeDeleteOnly } from "../lib/hooks";
import {
  buildTreemapComposition,
  colorForExtension,
  type TreemapFeaturedItem,
} from "../lib/treemap";
import { nativeApi } from "../nativeApi";
import { FileIcon } from "./FileIcon";
import { toast } from "./Toasts";
import type { TreemapLayout } from "../lib/treemap";
import { Treemap } from "./Treemap";

const MONITORING_NUDGE_DISMISSED_KEY = "diskhound:monitoring-nudge-dismissed";
const TREEMAP_FOLDERS_STORAGE_KEY = "diskhound:treemap-folders";

interface Props {
  snapshot: ScanSnapshot;
  onFilterExtension: (ext: string) => void;
}

type TreemapMode = "condensed" | "all";
const TREEMAP_MODE_STORAGE_KEY = "diskhound:treemap-mode";
const TREEMAP_LAYOUT_STORAGE_KEY = "diskhound:treemap-layout";
const EXT_SIDEBAR_COLLAPSED_KEY = "diskhound:ext-sidebar-collapsed";

function getInitialTreemapMode(): TreemapMode {
  if (typeof window === "undefined") {
    return "condensed";
  }

  const stored = window.localStorage.getItem(TREEMAP_MODE_STORAGE_KEY);
  return stored === "all" ? "all" : "condensed";
}

function getInitialTreemapLayout(): TreemapLayout {
  if (typeof window === "undefined") return "size";
  const stored = window.localStorage.getItem(TREEMAP_LAYOUT_STORAGE_KEY);
  return stored === "tree" ? "tree" : "size";
}

function getInitialExtSidebarCollapsed(): boolean {
  if (typeof window === "undefined") return false;
  return window.localStorage.getItem(EXT_SIDEBAR_COLLAPSED_KEY) === "1";
}

function getInitialShowFolders(): boolean {
  if (typeof window === "undefined") return true;
  // Default ON — folder boundaries make Tree layout much easier to
  // parse. Stored as "0" explicitly when the user turns it off.
  return window.localStorage.getItem(TREEMAP_FOLDERS_STORAGE_KEY) !== "0";
}

// Dense treemap default — render up to this many files from the full file
// index on disk. 10k is plenty dense for a WinDirStat feel without hurting
// canvas render performance.
const DENSE_TREEMAP_LIMIT = 5_000;

export function Overview({ snapshot, onFilterExtension }: Props) {
  const { bytesSeen, filesVisited, directoriesVisited, skippedEntries } = snapshot;
  // Live-ticking elapsed: during a running scan the snapshot only updates
  // ~5x/second via progress messages, so the "elapsed" metric would
  // freeze between ticks — users reported seeing "0.0s" stuck on screen.
  // Recompute from startedAt locally on a 250ms interval so the counter
  // feels alive even when the scanner is mid-enumerate and hasn't
  // emitted a progress message yet.
  const [liveNow, setLiveNow] = useState(() => Date.now());
  useEffect(() => {
    if (snapshot.status !== "running" || snapshot.startedAt === null) return;
    const id = window.setInterval(() => setLiveNow(Date.now()), 250);
    return () => window.clearInterval(id);
  }, [snapshot.status, snapshot.startedAt]);
  const displayElapsedMs = snapshot.status === "running" && snapshot.startedAt !== null
    ? liveNow - snapshot.startedAt
    : snapshot.elapsedMs;
  const [treemapMode, setTreemapMode] = useState<TreemapMode>(getInitialTreemapMode);
  const [treemapLayout, setTreemapLayout] = useState<TreemapLayout>(getInitialTreemapLayout);
  const [extSidebarCollapsed, setExtSidebarCollapsed] = useState<boolean>(getInitialExtSidebarCollapsed);
  const [showFolders, setShowFolders] = useState<boolean>(getInitialShowFolders);
  const [dominantExpanded, setDominantExpanded] = useState(false);
  const [denseFiles, setDenseFiles] = useState<ScanFileRecord[] | null>(null);
  const { busy, runAction, handleEasyMove } = usePathActions();
  const safeDeleteOnly = useSafeDeleteOnly();

  // Load the dense file list from the persisted full-file index whenever a
  // completed scan is available. Falls back to the in-memory top-N if the
  // index isn't ready yet (e.g. during a running scan).
  useEffect(() => {
    if (snapshot.status !== "done" || !snapshot.rootPath) {
      setDenseFiles(null);
      return;
    }
    if (snapshot.largestFiles.length >= DENSE_TREEMAP_LIMIT) {
      setDenseFiles(null);
      return;
    }
    let cancelled = false;
    void nativeApi.getTreemapFiles(snapshot.rootPath, DENSE_TREEMAP_LIMIT).then((files) => {
      if (cancelled) return;
      setDenseFiles(files && files.length > 0 ? files : null);
    });
    return () => { cancelled = true; };
  }, [snapshot.status, snapshot.rootPath, snapshot.largestFiles.length]);

  // Prefer the dense file list; fall back to the snapshot's top-N while a
  // scan is running or if the index isn't available.
  const sourceFiles = denseFiles ?? snapshot.largestFiles;

  const treemapComposition = useMemo(
    () => buildTreemapComposition(sourceFiles),
    [sourceFiles],
  );
  const hasDominantFiles = treemapComposition.featuredFiles.length > 0;
  // "Condensed" extraction of dominant files only applies to the Size
  // layout. In Tree layout every file lives inside its parent dir and
  // pulling files out as cards breaks the hierarchy — so we bypass.
  const condensedMode = hasDominantFiles && treemapMode === "condensed" && treemapLayout === "size";
  const treemapFiles = condensedMode ? treemapComposition.mapFiles : sourceFiles;
  const featuredBytes = treemapComposition.featuredFiles.reduce(
    (sum, item) => sum + item.file.size,
    0,
  );
  const treemapAreaMode = treemapMode === "all" ? "exact" : "compressed";

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    window.localStorage.setItem(TREEMAP_MODE_STORAGE_KEY, treemapMode);
  }, [treemapMode]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(TREEMAP_LAYOUT_STORAGE_KEY, treemapLayout);
  }, [treemapLayout]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(EXT_SIDEBAR_COLLAPSED_KEY, extSidebarCollapsed ? "1" : "0");
  }, [extSidebarCollapsed]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(TREEMAP_FOLDERS_STORAGE_KEY, showFolders ? "1" : "0");
  }, [showFolders]);


  return (
    <div className="overview">
      <MonitoringNudge />
      <div className="metrics-strip">
        <Metric value={formatBytes(bytesSeen)} label="scanned" accent />
        <Metric value={formatCount(filesVisited)} label="files" />
        <Metric value={formatCount(directoriesVisited)} label="dirs" />
        <Metric value={formatCount(skippedEntries)} label="skipped" />
        <Metric value={formatElapsed(displayElapsedMs)} label="elapsed" />
      </div>

      <div className={`overview-body ${extSidebarCollapsed ? "ext-collapsed" : ""}`}>
        <div className="overview-main">
          <div className="treemap-panel">
            <div className="treemap-toolbar">
              <div className="treemap-toolbar-copy">
                <div className="treemap-toolbar-title">Treemap</div>
                {hasDominantFiles && (
                  <div className="treemap-toolbar-meta">
                    {formatCount(treemapComposition.featuredFiles.length)} dominant item
                    {treemapComposition.featuredFiles.length === 1 ? "" : "s"}
                  </div>
                )}
              </div>
              <div className="treemap-toolbar-controls">
                {/* Layout: how rects are arranged within the treemap */}
                <div className="treemap-mode-switch" role="tablist" aria-label="Treemap layout">
                  <button
                    type="button"
                    className={`treemap-mode-btn ${treemapLayout === "size" ? "active" : ""}`}
                    aria-pressed={treemapLayout === "size"}
                    title="Squarified by size — largest files dominate, ordered globally"
                    onClick={() => setTreemapLayout("size")}
                  >
                    Size
                  </button>
                  <button
                    type="button"
                    className={`treemap-mode-btn ${treemapLayout === "tree" ? "active" : ""}`}
                    aria-pressed={treemapLayout === "tree"}
                    title="Hierarchical (WinDirStat style) — files cluster inside their folder"
                    onClick={() => setTreemapLayout("tree")}
                  >
                    Tree
                  </button>
                </div>
                {/* Folder delineation toggle — only meaningful in Tree mode */}
                {treemapLayout === "tree" && (
                  <button
                    type="button"
                    className={`treemap-folders-toggle ${showFolders ? "active" : ""}`}
                    aria-pressed={showFolders}
                    title={showFolders ? "Hide folder boundaries" : "Show folder boundaries"}
                    onClick={() => setShowFolders((v) => !v)}
                  >
                    <svg width="12" height="12" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.4">
                      <path d="M1.5 3.5V11.5C1.5 12.05 1.95 12.5 2.5 12.5H11.5C12.05 12.5 12.5 12.05 12.5 11.5V5.5C12.5 4.95 12.05 4.5 11.5 4.5H7L5.5 2.5H2.5C1.95 2.5 1.5 2.95 1.5 3.5Z" />
                    </svg>
                    Folders
                  </button>
                )}
                {/* Mode: whether to extract dominant files into cards (only
                    meaningful for Size layout) */}
                {hasDominantFiles && treemapLayout === "size" && (
                  <div className="treemap-mode-switch" role="tablist" aria-label="Treemap mode">
                    <button
                      type="button"
                      className={`treemap-mode-btn ${treemapMode === "condensed" ? "active" : ""}`}
                      aria-pressed={treemapMode === "condensed"}
                      title="Separate dominant items so the rest of the map stays explorable"
                      onClick={() => setTreemapMode("condensed")}
                    >
                      Condensed
                    </button>
                    <button
                      type="button"
                      className={`treemap-mode-btn ${treemapMode === "all" ? "active" : ""}`}
                      aria-pressed={treemapMode === "all"}
                      title="Show the full all-in-one treemap with exact area sizing"
                      onClick={() => setTreemapMode("all")}
                    >
                      All
                    </button>
                  </div>
                )}
              </div>
            </div>

            {condensedMode && (
              <div className={`treemap-featured ${dominantExpanded ? "expanded" : "collapsed"}`}>
                <button
                  className="treemap-featured-header"
                  onClick={() => setDominantExpanded((v) => !v)}
                  aria-expanded={dominantExpanded}
                >
                  <svg
                    className="treemap-featured-chevron"
                    width="10" height="10" viewBox="0 0 10 10"
                    fill="none" stroke="currentColor" strokeWidth="1.5"
                    style={{ transform: dominantExpanded ? "rotate(90deg)" : "rotate(0deg)" }}
                  >
                    <path d="M3.5 2L7 5L3.5 8" />
                  </svg>
                  <div className="treemap-featured-title">
                    {treemapComposition.featuredFiles.length} dominant file{treemapComposition.featuredFiles.length === 1 ? "" : "s"}
                  </div>
                  <div className="treemap-featured-summary">{formatBytes(featuredBytes)}</div>
                </button>
                {dominantExpanded && (
                  <div className="treemap-featured-list">
                    {treemapComposition.featuredFiles.map((item, index) => (
                      <FeaturedFileCard
                        key={item.file.path}
                        item={item}
                        rank={index + 1}
                        isBusy={busy.has(item.file.path)}
                        safeDeleteOnly={safeDeleteOnly}
                        onReveal={() => void runAction(item.file.path, () => nativeApi.revealPath(item.file.path))}
                        onOpen={() => void runAction(item.file.path, () => nativeApi.openPath(item.file.path))}
                        onTrash={() => void runAction(item.file.path, () => nativeApi.trashPath(item.file.path))}
                        onDelete={() => {
                          if (confirm(`Permanently delete ${item.file.name}?\n\nThis cannot be undone.`)) {
                            void runAction(item.file.path, () => nativeApi.permanentlyDeletePath(item.file.path));
                          }
                        }}
                        onMove={() => void handleEasyMove(item.file.path)}
                      />
                    ))}
                  </div>
                )}
              </div>
            )}

            <div className="treemap-stage">
              {/* A running scan on this root but no data yet → show scanning
               * state, not the generic "Run a scan" empty state. This is
               * the fix for the "came back to window and treemap says run
               * a scan even though it's scanning" bug. */}
              {snapshot.status === "running" && treemapFiles.length === 0 ? (
                <div className="treemap-empty">
                  <div className="treemap-empty-icon">
                    <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" opacity="0.7">
                      <circle cx="12" cy="12" r="9" strokeDasharray="6 4" />
                      <path d="M12 2L12 6M12 18L12 22M2 12L6 12M18 12L22 12" />
                    </svg>
                  </div>
                  {(() => {
                    // Three distinct pre-results states:
                    //   1. First second: "Starting…" (no real signal yet)
                    //   2. filesVisited === 0 after a bit: we're likely in
                    //      the rescan baseline-load phase on a big index
                    //   3. filesVisited > 0: actively walking
                    const hasFiles = snapshot.filesVisited > 0;
                    const longLoad = !hasFiles && displayElapsedMs > 3000;
                    const title = hasFiles
                      ? `Scanning ${snapshot.rootPath}…`
                      : longLoad
                        ? `Preparing from previous scan of ${snapshot.rootPath}…`
                        : `Starting scan of ${snapshot.rootPath}…`;
                    const sub = hasFiles
                      ? `${formatCount(snapshot.filesVisited)} files · ${formatBytes(snapshot.bytesSeen)} · ${formatElapsed(displayElapsedMs)} elapsed`
                      : longLoad
                        ? `Reading the prior scan's index so unchanged folders can be inherited instead of re-walked (${formatElapsed(displayElapsedMs)} elapsed).`
                        : `Enumerating the root — largest files appear as soon as the first few are seen (${formatElapsed(displayElapsedMs)} elapsed)`;
                    return (
                      <>
                        <div style={{ fontSize: 13, color: "var(--text)" }}>{title}</div>
                        <div style={{ fontSize: 11, color: "var(--text-muted)", maxWidth: 480, textAlign: "center" }}>
                          {sub}
                        </div>
                      </>
                    );
                  })()}
                </div>
              ) : snapshot.status === "idle" && snapshot.rootPath && treemapFiles.length === 0 ? (
                // Valid root selected but never scanned — offer a clear CTA.
                <div className="treemap-empty">
                  <div className="treemap-empty-icon">&#x25A6;</div>
                  <div style={{ fontSize: 13, color: "var(--text)" }}>
                    No scan data for {snapshot.rootPath}
                  </div>
                  <div style={{ fontSize: 11, color: "var(--text-muted)" }}>
                    Hit "Rescan" in the header to run a scan on this drive.
                  </div>
                </div>
              ) : (
                <Treemap
                  files={treemapFiles}
                  areaMode={treemapAreaMode}
                  layout={treemapLayout}
                  showFolderOutlines={showFolders}
                />
              )}
            </div>
          </div>
        </div>

        <div className={`ext-sidebar ${extSidebarCollapsed ? "collapsed" : ""}`}>
          {extSidebarCollapsed ? (
            <button
              className="ext-sidebar-collapsed-tab"
              onClick={() => setExtSidebarCollapsed(false)}
              title="Show extensions"
              aria-label="Show extensions"
              aria-expanded={false}
            >
              <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.6">
                <path d="M7 2L3 5L7 8" />
              </svg>
              <span className="ext-sidebar-collapsed-label">Extensions</span>
            </button>
          ) : (
            <>
              <div className="ext-sidebar-header">
                <span>Extensions</span>
                <button
                  className="ext-sidebar-toggle"
                  onClick={() => setExtSidebarCollapsed(true)}
                  title="Hide extensions"
                  aria-label="Hide extensions"
                  aria-expanded={true}
                >
                  <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.6">
                    <path d="M3 2L7 5L3 8" />
                  </svg>
                </button>
              </div>
              <div className="ext-sidebar-list">
                {snapshot.topExtensions.length === 0 ? (
                  <div className="empty-view" style={{ height: "100%" }}>
                    <span>No data yet</span>
                  </div>
                ) : (
                  snapshot.topExtensions.map((b) => (
                    <ExtRow
                      key={b.extension}
                      bucket={b}
                      totalBytes={bytesSeen}
                      onClick={() => onFilterExtension(b.extension)}
                    />
                  ))
                )}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function FeaturedFileCard({ item, rank, isBusy, safeDeleteOnly, onReveal, onOpen, onTrash, onDelete, onMove }: {
  item: TreemapFeaturedItem;
  rank: number;
  isBusy: boolean;
  safeDeleteOnly: boolean;
  onReveal: () => void;
  onOpen: () => void;
  onTrash: () => void;
  onDelete: () => void;
  onMove: () => void;
}) {
  const color = colorForExtension(item.file.extension);

  return (
    <div className="treemap-featured-card" title={item.file.path}>
      <div className="treemap-featured-card-head">
        <div className="treemap-featured-rank">#{rank}</div>
        <div className="treemap-featured-share">{Math.round(item.share * 100)}%</div>
      </div>
      <div className="treemap-featured-name-row">
        <FileIcon path={item.file.path} className="treemap-featured-icon" fallback={<span className="ext-dot" style={{ background: color }} />} />
        <span className="treemap-featured-name">{item.file.name}</span>
      </div>
      <div className="treemap-featured-path">{item.file.path}</div>
      <div className="treemap-featured-size-row">
        <span className="treemap-featured-size">{formatBytes(item.file.size)}</span>
        <span className="treemap-featured-type">{item.file.extension}</span>
      </div>
      <div className="treemap-featured-modified">
        Modified {humanAge(item.file.modifiedAt)}
      </div>
      <div className="treemap-featured-bar">
        <div
          className="treemap-featured-bar-fill"
          style={{ width: `${Math.max(item.share * 100, 3)}%`, background: color }}
        />
      </div>
      <div className="treemap-featured-actions">
        <button className="action-btn" disabled={isBusy} onClick={onReveal}>Reveal</button>
        <button className="action-btn" disabled={isBusy} onClick={onOpen}>Open</button>
        <button className="action-btn warn" disabled={isBusy} onClick={onTrash}>Trash</button>
        {!safeDeleteOnly && <button className="action-btn danger" disabled={isBusy} onClick={onDelete}>Del</button>}
        <button className="action-btn" disabled={isBusy} onClick={onMove}>Move</button>
      </div>
    </div>
  );
}

function Metric({ value, label, accent }: { value: string; label: string; accent?: boolean }) {
  return (
    <div className="metric">
      <span className={`metric-value ${accent ? "accent" : ""}`}>{value}</span>
      <span className="metric-label">{label}</span>
    </div>
  );
}

/**
 * Dismissible banner that nudges the user to turn on background monitoring.
 * Shows only when monitoring is currently off AND the user hasn't dismissed
 * it previously (persisted via localStorage). Clicking "Enable" flips the
 * setting on and dismisses the banner; clicking the × just dismisses.
 */
function MonitoringNudge() {
  const [monitoringEnabled, setMonitoringEnabled] = useState<boolean | null>(null);
  const [dismissed, setDismissed] = useState<boolean>(() => {
    if (typeof window === "undefined") return false;
    return window.localStorage.getItem(MONITORING_NUDGE_DISMISSED_KEY) === "1";
  });
  const [enabling, setEnabling] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void nativeApi.getSettings().then((s) => {
      if (!cancelled && s) setMonitoringEnabled(s.monitoring.enabled);
    });
    return () => { cancelled = true; };
  }, []);

  const dismiss = () => {
    setDismissed(true);
    try { window.localStorage.setItem(MONITORING_NUDGE_DISMISSED_KEY, "1"); } catch { /* ignore */ }
  };

  const enable = async () => {
    setEnabling(true);
    try {
      const s = await nativeApi.getSettings();
      if (!s) return;
      await nativeApi.updateSettings({
        ...s,
        monitoring: { ...s.monitoring, enabled: true },
      });
      setMonitoringEnabled(true);
      toast("success", "Background monitoring enabled",
        `DiskHound will rescan every ${s.monitoring.fullScanIntervalMinutes || 60} min and keep recording new snapshots for comparison.`);
      dismiss();
    } finally {
      setEnabling(false);
    }
  };

  if (monitoringEnabled !== false || dismissed) return null;

  return (
    <div className="monitoring-nudge">
      <div className="monitoring-nudge-icon" aria-hidden="true">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7">
          <path d="M12 2a6 6 0 0 0-6 6v3.6c0 .6-.3 1.2-.8 1.6L4 14v1h16v-1l-1.2-.8a2 2 0 0 1-.8-1.6V8a6 6 0 0 0-6-6z" />
          <path d="M10 18a2 2 0 0 0 4 0" />
        </svg>
      </div>
      <div className="monitoring-nudge-text">
        <strong>Turn on background monitoring</strong>
        <span>
          {" "}— DiskHound will rescan on a schedule and keep building scan history for this path.
          On supported NTFS volumes, some follow-up scans can use the Windows change journal;
          otherwise DiskHound falls back to scheduled rescans.
        </span>
      </div>
      <div className="monitoring-nudge-actions">
        <button className="action-btn primary" disabled={enabling} onClick={() => void enable()}>
          {enabling ? "Enabling…" : "Enable"}
        </button>
        <button className="monitoring-nudge-dismiss" onClick={dismiss} title="Dismiss">
          ×
        </button>
      </div>
    </div>
  );
}

function ExtRow({ bucket, totalBytes, onClick }: {
  bucket: ExtensionBucket;
  totalBytes: number;
  onClick: () => void;
}) {
  const pct = totalBytes > 0 ? (bucket.size / totalBytes) * 100 : 0;
  const color = colorForExtension(bucket.extension);

  return (
    <div className="ext-row" onClick={onClick}>
      <span className="ext-name">
        <span className="ext-dot" style={{ background: color }} />
        {bucket.extension}
      </span>
      <div className="ext-info">
        <div className="ext-size">{formatBytes(bucket.size)}</div>
        <div className="ext-count">{formatCount(bucket.count)}</div>
      </div>
      <div className="ext-bar-wrap">
        <div className="ext-bar-fill" style={{ width: `${pct}%`, background: color }} />
      </div>
    </div>
  );
}
