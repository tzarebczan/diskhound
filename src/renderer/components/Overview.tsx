import { useEffect, useMemo, useState } from "preact/hooks";

import type { ExtensionBucket, ScanSnapshot } from "../../shared/contracts";
import { formatBytes, formatCount, formatElapsed } from "../lib/format";
import {
  buildTreemapComposition,
  colorForExtension,
  type TreemapFeaturedItem,
} from "../lib/treemap";
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

export function Overview({ snapshot, onFilterExtension }: Props) {
  const { bytesSeen, filesVisited, directoriesVisited, skippedEntries, elapsedMs } = snapshot;
  const [treemapMode, setTreemapMode] = useState<TreemapMode>(getInitialTreemapMode);
  const treemapComposition = useMemo(
    () => buildTreemapComposition(snapshot.largestFiles),
    [snapshot.largestFiles],
  );
  const hasDominantFiles = treemapComposition.featuredFiles.length > 0;
  const condensedMode = hasDominantFiles && treemapMode === "condensed";
  const treemapFiles = condensedMode ? treemapComposition.mapFiles : snapshot.largestFiles;
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
              <div className="treemap-featured">
                <div className="treemap-featured-header">
                  <div className="treemap-featured-title">Dominant Files</div>
                  <div className="treemap-featured-summary">{formatBytes(featuredBytes)}</div>
                </div>
                <div className="treemap-featured-list">
                  {treemapComposition.featuredFiles.map((item, index) => (
                    <FeaturedFileCard key={item.file.path} item={item} rank={index + 1} />
                  ))}
                </div>
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

function FeaturedFileCard({ item, rank }: { item: TreemapFeaturedItem; rank: number }) {
  const color = colorForExtension(item.file.extension);

  return (
    <div className="treemap-featured-card" title={item.file.path}>
      <div className="treemap-featured-card-head">
        <div className="treemap-featured-rank">#{rank}</div>
        <div className="treemap-featured-share">{Math.round(item.share * 100)}%</div>
      </div>
      <div className="treemap-featured-name-row">
        <span className="ext-dot" style={{ background: color }} />
        <span className="treemap-featured-name">{item.file.name}</span>
      </div>
      <div className="treemap-featured-path">{item.file.path}</div>
      <div className="treemap-featured-size-row">
        <span className="treemap-featured-size">{formatBytes(item.file.size)}</span>
        <span className="treemap-featured-type">{item.file.extension}</span>
      </div>
      <div className="treemap-featured-bar">
        <div
          className="treemap-featured-bar-fill"
          style={{ width: `${Math.max(item.share * 100, 3)}%`, background: color }}
        />
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
