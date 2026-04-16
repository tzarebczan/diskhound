import type { ExtensionBucket, ScanSnapshot } from "../../shared/contracts";
import { formatBytes, formatCount, formatElapsed } from "../lib/format";
import { colorForExtension } from "../lib/treemap";
import { Treemap } from "./Treemap";

interface Props {
  snapshot: ScanSnapshot;
  onFilterExtension: (ext: string) => void;
}

export function Overview({ snapshot, onFilterExtension }: Props) {
  const { bytesSeen, filesVisited, directoriesVisited, skippedEntries, elapsedMs } = snapshot;

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
        <Treemap files={snapshot.largestFiles} />

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
