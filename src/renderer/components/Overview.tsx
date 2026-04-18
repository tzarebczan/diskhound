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
import { Treemap } from "./Treemap";

interface Props {
  snapshot: ScanSnapshot;
  onFilterExtension: (ext: string) => void;
}

type TreemapMode = "condensed" | "all";
const TREEMAP_MODE_STORAGE_KEY = "diskhound:treemap-mode";

function getInitialTreemapMode(): TreemapMode {
  if (typeof window === "undefined") {
    return "condensed";
  }

  const stored = window.localStorage.getItem(TREEMAP_MODE_STORAGE_KEY);
  return stored === "all" ? "all" : "condensed";
}

// Dense treemap default — render up to this many files from the full file
// index. Independent of the `topFileLimit` setting (which now only controls
// the Largest Files list). 10k is plenty dense for a WinDirStat feel without
// hurting canvas render performance.
const DENSE_TREEMAP_LIMIT = 10_000;

export function Overview({ snapshot, onFilterExtension }: Props) {
  const { bytesSeen, filesVisited, directoriesVisited, skippedEntries, elapsedMs } = snapshot;
  const [treemapMode, setTreemapMode] = useState<TreemapMode>(getInitialTreemapMode);
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
    let cancelled = false;
    void nativeApi.getTreemapFiles(snapshot.rootPath, DENSE_TREEMAP_LIMIT).then((files) => {
      if (cancelled) return;
      setDenseFiles(files && files.length > 0 ? files : null);
    });
    return () => { cancelled = true; };
  }, [snapshot.status, snapshot.rootPath]);

  // Prefer the dense file list; fall back to the snapshot's top-N while a
  // scan is running or if the index isn't available.
  const sourceFiles = denseFiles ?? snapshot.largestFiles;

  const treemapComposition = useMemo(
    () => buildTreemapComposition(sourceFiles),
    [sourceFiles],
  );
  const hasDominantFiles = treemapComposition.featuredFiles.length > 0;
  const condensedMode = hasDominantFiles && treemapMode === "condensed";
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

  return (
    <div className="overview">
      <div className="metrics-strip">
        <Metric value={formatBytes(bytesSeen)} label="scanned" accent />
        <Metric value={formatCount(filesVisited)} label="files" />
        <Metric value={formatCount(directoriesVisited)} label="dirs" />
        <Metric value={formatCount(skippedEntries)} label="skipped" />
        <Metric value={formatElapsed(elapsedMs)} label="elapsed" />
      </div>

      <div className="overview-body">
        <div className="overview-main">
          <div className="treemap-panel">
            {hasDominantFiles && (
              <div className="treemap-toolbar">
                <div className="treemap-toolbar-copy">
                  <div className="treemap-toolbar-title">Treemap</div>
                  <div className="treemap-toolbar-meta">
                    {formatCount(treemapComposition.featuredFiles.length)} dominant item
                    {treemapComposition.featuredFiles.length === 1 ? "" : "s"}
                  </div>
                </div>
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
              </div>
            )}

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
              <Treemap files={treemapFiles} areaMode={treemapAreaMode} />
            </div>
          </div>
        </div>

        <div className="ext-sidebar">
          <div className="ext-sidebar-header">Extensions</div>
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
