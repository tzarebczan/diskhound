import { useCallback, useEffect, useMemo, useRef, useState } from "preact/hooks";

import type {
  DirectoryDelta,
  ExtensionDelta,
  FileDelta,
  FullDiffResult,
  FullFileChange,
  ScanDiffResult,
  ScanHistoryEntry,
  ScanSnapshot,
} from "../../shared/contracts";
import { basename, formatBytes, relativeTime } from "../lib/format";
import { usePathActions } from "../lib/hooks";
import { nativeApi } from "../nativeApi";

interface Props {
  rootPath: string | null;
  /** The live snapshot — used to detect scan completions for auto-refresh. */
  snapshot: ScanSnapshot;
}

type DetailTab = "files" | "directories" | "extensions";

// ── Time range definitions ─────────────────────────────────

interface TimeRange {
  id: string;
  label: string;
  ms: number;
}

const TIME_RANGES: TimeRange[] = [
  { id: "1h",  label: "1h",  ms: 60 * 60 * 1000 },
  { id: "6h",  label: "6h",  ms: 6 * 60 * 60 * 1000 },
  { id: "1d",  label: "1d",  ms: 24 * 60 * 60 * 1000 },
  { id: "1w",  label: "1w",  ms: 7 * 24 * 60 * 60 * 1000 },
  { id: "1M",  label: "1M",  ms: 30 * 24 * 60 * 60 * 1000 },
  { id: "3M",  label: "3M",  ms: 90 * 24 * 60 * 60 * 1000 },
];

interface ResolvedRange {
  range: TimeRange;
  entry: ScanHistoryEntry | null;
  previewDelta: number;
  disabled: boolean;
}

/** Find the history entry closest to `range.ms` ago from the latest scan. */
function resolveTimeRange(range: TimeRange, history: ScanHistoryEntry[]): ResolvedRange {
  const base = { range, entry: null, previewDelta: 0, disabled: true };
  if (history.length < 2) return base;

  const latest = history[0];
  const targetTime = latest.scannedAt - range.ms;
  const toleranceMs = range.ms * 0.5;

  // Find the entry with scannedAt closest to targetTime (skip index 0 = latest)
  let best = history[1];
  let bestDist = Math.abs(best.scannedAt - targetTime);

  for (let i = 2; i < history.length; i++) {
    const dist = Math.abs(history[i].scannedAt - targetTime);
    if (dist < bestDist) {
      best = history[i];
      bestDist = dist;
    }
  }

  // Require the chosen baseline to land reasonably close to the requested
  // range; otherwise sparse history can enable "1h"/"1d" pills that actually
  // point at scans weeks or months away.
  if (bestDist > toleranceMs) return base;

  return {
    range,
    entry: best,
    previewDelta: latest.bytesSeen - best.bytesSeen,
    disabled: false,
  };
}

// ── Main component ─────────────────────────────────────────

export function ChangesView({ rootPath, snapshot }: Props) {
  const [diff, setDiff] = useState<ScanDiffResult | null>(null);
  const [history, setHistory] = useState<ScanHistoryEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedBaseline, setSelectedBaseline] = useState<string | null>(null);
  const [activeQuickSelect, setActiveQuickSelect] = useState<string | null>(null);
  const [detailTab, setDetailTab] = useState<DetailTab>("files");
  const [fullDiff, setFullDiff] = useState<FullDiffResult | null>(null);
  const [fullDiffLoading, setFullDiffLoading] = useState(false);
  const { busy, runAction, handleEasyMove } = usePathActions();
  const prevStatusRef = useRef(snapshot.status);

  // Resolve all time ranges from history (pure, no IPC)
  const resolvedRanges = useMemo(
    () => TIME_RANGES.map((r) => resolveTimeRange(r, history)),
    [history],
  );

  // Shared load function — used on mount and after scan completes
  const loadData = useCallback(async (root: string) => {
    const [h, d] = await Promise.all([
      nativeApi.getScanHistory(root),
      nativeApi.getLatestDiff(root),
    ]);
    return { history: h, diff: d };
  }, []);

  // Load history + latest diff on mount or when root changes
  useEffect(() => {
    if (!rootPath) {
      setHistory([]);
      setDiff(null);
      setSelectedBaseline(null);
      setActiveQuickSelect(null);
      setLoading(false);
      return;
    }

    let cancelled = false;
    setLoading(true);
    setHistory([]);
    setDiff(null);
    setSelectedBaseline(null);
    setActiveQuickSelect(null);

    void (async () => {
      const data = await loadData(rootPath);
      if (cancelled) return;
      if (data.history) setHistory(data.history);
      if (data.diff) {
        setDiff(data.diff);
        setSelectedBaseline(data.diff.baselineId);
        const matchingQuickSelect = TIME_RANGES
          .map((range) => resolveTimeRange(range, data.history))
          .find((resolved) => resolved.entry?.id === data.diff!.baselineId);
        setActiveQuickSelect(matchingQuickSelect?.range.id ?? null);
      }
      setLoading(false);
    })();

    return () => { cancelled = true; };
  }, [rootPath, loadData]);

  // Auto-refresh when a scan completes (status transitions to "done")
  useEffect(() => {
    const prevStatus = prevStatusRef.current;
    prevStatusRef.current = snapshot.status;

    if (prevStatus !== "done" && snapshot.status === "done" && rootPath) {
      // Scan just finished — reload history + diff
      void (async () => {
        const data = await loadData(rootPath);
        if (data.history) setHistory(data.history);
        if (data.diff) {
          setDiff(data.diff);
          setSelectedBaseline(data.diff.baselineId);
          const matchingQuickSelect = TIME_RANGES
            .map((range) => resolveTimeRange(range, data.history))
            .find((resolved) => resolved.entry?.id === data.diff!.baselineId);
          setActiveQuickSelect(matchingQuickSelect?.range.id ?? null);
        }
      })();
    }
  }, [snapshot.status, rootPath, loadData]);

  // Compare against a different baseline
  const selectBaseline = async (baselineId: string) => {
    if (!history.length) return;
    const currentId = history[0].id;
    setSelectedBaseline(baselineId);
    setFullDiff(null); // invalidate — applies to different baseline now
    setLoading(true);
    const d = await nativeApi.computeScanDiff(baselineId, currentId);
    if (d) setDiff(d);
    setLoading(false);
  };

  const loadFullDiff = async () => {
    if (!diff) return;
    setFullDiffLoading(true);
    const result = await nativeApi.computeFullScanDiff(diff.baselineId, diff.currentId, 1000);
    if (result) setFullDiff(result);
    setFullDiffLoading(false);
  };

  if (!rootPath) {
    return (
      <div className="changes-view">
        <div className="empty-view"><span>Run a scan to see changes over time</span></div>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="changes-view">
        <div className="empty-view"><span>Loading history...</span></div>
      </div>
    );
  }

  if (!diff) {
    return (
      <div className="changes-view">
        <div className="changes-empty">
          <div className="changes-empty-icon">
            <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1" opacity="0.3">
              <path d="M12 8V12L15 15" />
              <circle cx="12" cy="12" r="9" />
            </svg>
          </div>
          <div className="changes-empty-text">No previous scan to compare</div>
          <div className="changes-empty-hint">
            Run another scan of the same path to see what changed.
            {history.length === 1 && " One scan recorded so far."}
          </div>
        </div>
      </div>
    );
  }

  // Zero-change handling
  const isZeroDelta = diff.totalBytesDelta === 0;
  const gained = diff.totalBytesDelta > 0;
  const netLabel = isZeroDelta ? "unchanged" : gained ? "grew" : "freed";
  const netColorClass = isZeroDelta ? "neutral" : gained ? "negative" : "positive";

  return (
    <div className="changes-view">
      {/* ── Summary strip ── */}
      <div className="changes-summary">
        <div className="changes-summary-net">
          <span className={`changes-delta-big ${netColorClass}`}>
            {isZeroDelta ? "0 B" : `${gained ? "+" : ""}${formatBytes(Math.abs(diff.totalBytesDelta))}`}
          </span>
          <span className="changes-delta-label">net {netLabel}</span>
        </div>
        <div className="changes-summary-stats">
          <SummaryItem label="Previous" value={formatBytes(diff.previousBytesSeen)} />
          <SummaryItem label="Current" value={formatBytes(diff.currentBytesSeen)} />
          <SummaryItem
            label="Files"
            value={`${diff.totalFilesDelta >= 0 ? "+" : ""}${diff.totalFilesDelta.toLocaleString()}`}
          />
          <SummaryItem
            label="Time between"
            value={formatTimeBetween(diff.timeBetweenMs)}
          />
        </div>
      </div>

      {/* ── Body: history sidebar + detail area ── */}
      <div className="changes-body">
        {/* History sidebar */}
        <div className="changes-history">
          <div className="changes-history-title">Scan History</div>

          {/* Quick-select time range pills */}
          <QuickSelectPills
            resolvedRanges={resolvedRanges}
            activeId={activeQuickSelect}
            onSelect={(rangeId, entryId) => {
              setActiveQuickSelect(rangeId);
              void selectBaseline(entryId);
            }}
          />

          <div className="changes-history-list">
            {history.map((h, i) => {
              const isLatest = i === 0;
              const isSelected = h.id === selectedBaseline;
              const prevEntry = history[i + 1];
              const sizeDelta = prevEntry ? h.bytesSeen - prevEntry.bytesSeen : 0;
              return (
                <button
                  key={h.id}
                  className={`changes-history-item ${isSelected ? "selected" : ""} ${isLatest ? "latest" : ""}`}
                  onClick={() => {
                    if (isLatest) return;
                    setActiveQuickSelect(null);
                    void selectBaseline(h.id);
                  }}
                  disabled={isLatest}
                  title={isLatest ? "Current scan (comparing against)" : "Compare against this scan"}
                >
                  <div className="changes-history-date">
                    {relativeTime(h.scannedAt)}
                    {isLatest && <span className="changes-history-badge">latest</span>}
                  </div>
                  <div className="changes-history-meta">
                    <span>{formatBytes(h.bytesSeen)}</span>
                    <span>{h.filesVisited.toLocaleString()} files</span>
                  </div>
                  {sizeDelta !== 0 && !isLatest && (
                    <div className={`changes-history-delta ${sizeDelta > 0 ? "negative" : "positive"}`}>
                      {sizeDelta > 0 ? "+" : ""}{formatBytes(Math.abs(sizeDelta))}
                    </div>
                  )}
                </button>
              );
            })}
          </div>
        </div>

        {/* Detail panel */}
        <div className="changes-detail">
          {/* Detail tabs */}
          <div className="changes-detail-tabs">
            <button
              className={`changes-tab ${detailTab === "files" ? "active" : ""}`}
              onClick={() => setDetailTab("files")}
            >
              Files ({diff.fileDeltas.length})
            </button>
            <button
              className={`changes-tab ${detailTab === "directories" ? "active" : ""}`}
              onClick={() => setDetailTab("directories")}
            >
              Directories ({diff.directoryDeltas.length})
            </button>
            <button
              className={`changes-tab ${detailTab === "extensions" ? "active" : ""}`}
              onClick={() => setDetailTab("extensions")}
            >
              Extensions ({diff.extensionDeltas.length})
            </button>
          </div>

          {/* Detail list */}
          <div className="changes-detail-scroll">
            {detailTab === "files" && !fullDiff && (
              <>
                <FileDeltaList
                  deltas={diff.fileDeltas}
                  busy={busy}
                  onReveal={(p) => void runAction(p, () => nativeApi.revealPath(p))}
                  onOpen={(p) => void runAction(p, () => nativeApi.openPath(p))}
                  onTrash={(p) => void runAction(p, () => nativeApi.trashPath(p))}
                  onEasyMove={(p) => void handleEasyMove(p)}
                />
                <div className="changes-full-diff-cta">
                  <button
                    className="scan-btn"
                    disabled={fullDiffLoading}
                    onClick={() => void loadFullDiff()}
                  >
                    {fullDiffLoading ? "Loading..." : "Browse all changes"}
                  </button>
                  <span className="changes-full-diff-hint">
                    Load the full per-file diff from the persisted index.
                  </span>
                </div>
              </>
            )}
            {detailTab === "files" && fullDiff && (
              <FullDiffList
                diff={fullDiff}
                busy={busy}
                onReveal={(p) => void runAction(p, () => nativeApi.revealPath(p))}
                onOpen={(p) => void runAction(p, () => nativeApi.openPath(p))}
                onTrash={(p) => void runAction(p, () => nativeApi.trashPath(p))}
                onEasyMove={(p) => void handleEasyMove(p)}
                onShowTopN={() => setFullDiff(null)}
              />
            )}
            {detailTab === "directories" && (
              <DirDeltaList
                deltas={diff.directoryDeltas}
                busy={busy}
                onReveal={(p) => void runAction(p, () => nativeApi.revealPath(p))}
                onOpen={(p) => void runAction(p, () => nativeApi.openPath(p))}
                onEasyMove={(p) => void handleEasyMove(p)}
              />
            )}
            {detailTab === "extensions" && <ExtDeltaList deltas={diff.extensionDeltas} />}
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Sub-components ─────────────────────────────────────────

function QuickSelectPills({ resolvedRanges, activeId, onSelect }: {
  resolvedRanges: ResolvedRange[];
  activeId: string | null;
  onSelect: (rangeId: string, entryId: string) => void;
}) {
  return (
    <div className="changes-quickselect">
      {resolvedRanges.map(({ range, entry, previewDelta, disabled }) => {
        const isActive = activeId === range.id;
        const deltaClass = previewDelta > 0
          ? "negative"
          : previewDelta < 0
            ? "positive"
            : "neutral";

        return (
          <button
            key={range.id}
            className={`changes-range-pill ${isActive ? "active" : ""}`}
            disabled={disabled}
            onClick={() => { if (entry) onSelect(range.id, entry.id); }}
            title={disabled
              ? `No scan data for ${range.label} ago`
              : `Compare against scan from ~${range.label} ago`}
          >
            <span className="changes-range-label">{range.label}</span>
            <span className={`changes-range-delta ${deltaClass}`}>
              {disabled
                ? "---"
                : `${previewDelta > 0 ? "+" : ""}${formatBytes(Math.abs(previewDelta))}`}
            </span>
          </button>
        );
      })}
    </div>
  );
}

function SummaryItem({ label, value }: { label: string; value: string }) {
  return (
    <div className="changes-stat">
      <span className="changes-stat-value">{value}</span>
      <span className="changes-stat-label">{label}</span>
    </div>
  );
}

interface DeltaListActions {
  busy: Set<string>;
  onReveal: (path: string) => void;
  onOpen: (path: string) => void;
  onTrash?: (path: string) => void;
  onEasyMove: (path: string) => void;
}

function FileDeltaList({ deltas, busy, onReveal, onOpen, onTrash, onEasyMove }: { deltas: FileDelta[] } & DeltaListActions) {
  if (deltas.length === 0) {
    return <div className="changes-empty-detail">No file changes detected in tracked files</div>;
  }

  return (
    <>
      <div className="changes-caveat">
        Based on the largest files tracked by the scanner. Smaller files outside the top-N are not compared.
      </div>
      {deltas.map((d) => {
        const isBusy = busy.has(d.path);
        const isActionable = d.kind !== "removed";
        return (
          <div key={d.path} className="changes-row">
            <div className={`changes-row-badge ${badgeClass(d.kind)}`}>{d.kind}</div>
            <div className="changes-row-info">
              <div className="changes-row-name">{d.name}</div>
              <div className="changes-row-path">{d.path}</div>
            </div>
            <DeltaCell delta={d.deltaBytes} />
            <div className="changes-row-sizes">
              {d.kind === "added" ? (
                <span>{formatBytes(d.size)}</span>
              ) : d.kind === "removed" ? (
                <span className="changes-row-prev">{formatBytes(d.previousSize)}</span>
              ) : (
                <>
                  <span className="changes-row-prev">{formatBytes(d.previousSize)}</span>
                  <span className="changes-row-arrow">&rarr;</span>
                  <span>{formatBytes(d.size)}</span>
                </>
              )}
            </div>
            {isActionable && (
              <div className="changes-row-actions">
                <button className="action-btn" disabled={isBusy} onClick={() => onReveal(d.path)}>Reveal</button>
                <button className="action-btn" disabled={isBusy} onClick={() => onOpen(d.path)}>Open</button>
                {onTrash && <button className="action-btn warn" disabled={isBusy} onClick={() => onTrash(d.path)}>Trash</button>}
                <button className="action-btn" disabled={isBusy} onClick={() => onEasyMove(d.path)}>Move</button>
              </div>
            )}
          </div>
        );
      })}
    </>
  );
}

function DirDeltaList({ deltas, busy, onReveal, onOpen, onEasyMove }: { deltas: DirectoryDelta[] } & Omit<DeltaListActions, "onTrash">) {
  // Skip the root directory (depth 0) — it's just the net total
  const filtered = useMemo(
    () => deltas.filter((d) => d.path.split(/[\\/]/).length > 2),
    [deltas],
  );

  if (filtered.length === 0) {
    return <div className="changes-empty-detail">No directory changes detected in tracked directories</div>;
  }

  return (
    <>
      {filtered.map((d) => {
        const name = basename(d.path);
        const isBusy = busy.has(d.path);
        const isActionable = d.kind !== "removed";
        return (
          <div key={d.path} className="changes-row">
            <div className={`changes-row-badge ${badgeClass(d.kind)}`}>{d.kind}</div>
            <div className="changes-row-info">
              <div className="changes-row-name">{name}</div>
              <div className="changes-row-path">{d.path}</div>
            </div>
            <DeltaCell delta={d.deltaBytes} />
            <div className="changes-row-sizes">
              {d.kind === "added" ? (
                <span>{formatBytes(d.size)} ({d.fileCount} files)</span>
              ) : d.kind === "removed" ? (
                <span className="changes-row-prev">{formatBytes(d.previousSize)}</span>
              ) : (
                <>
                  <span className="changes-row-prev">{formatBytes(d.previousSize)}</span>
                  <span className="changes-row-arrow">&rarr;</span>
                  <span>{formatBytes(d.size)}</span>
                  <FileDeltaCount prev={d.previousFileCount} curr={d.fileCount} />
                </>
              )}
            </div>
            {isActionable && (
              <div className="changes-row-actions">
                <button className="action-btn" disabled={isBusy} onClick={() => onReveal(d.path)}>Reveal</button>
                <button className="action-btn" disabled={isBusy} onClick={() => onOpen(d.path)}>Open</button>
                <button className="action-btn" disabled={isBusy} onClick={() => onEasyMove(d.path)}>Move</button>
              </div>
            )}
          </div>
        );
      })}
    </>
  );
}

function ExtDeltaList({ deltas }: { deltas: ExtensionDelta[] }) {
  if (deltas.length === 0) {
    return <div className="changes-empty-detail">No extension changes detected</div>;
  }

  return (
    <>
      {deltas.map((d) => (
        <div key={d.extension} className="changes-row">
          <div className={`changes-row-badge ${d.deltaBytes > 0 ? "grew" : "shrank"}`}>
            {d.deltaBytes > 0 ? "grew" : "shrank"}
          </div>
          <div className="changes-row-info">
            <div className="changes-row-name">{d.extension}</div>
            <div className="changes-row-path">
              {d.previousCount} &rarr; {d.count} files
            </div>
          </div>
          <DeltaCell delta={d.deltaBytes} />
          <div className="changes-row-sizes">
            <span className="changes-row-prev">{formatBytes(d.previousSize)}</span>
            <span className="changes-row-arrow">&rarr;</span>
            <span>{formatBytes(d.size)}</span>
          </div>
        </div>
      ))}
    </>
  );
}

function DeltaCell({ delta }: { delta: number }) {
  if (delta === 0) {
    return <div className="changes-row-delta neutral">=</div>;
  }
  const positive = delta < 0; // space freed = positive for user
  return (
    <div className={`changes-row-delta ${positive ? "positive" : "negative"}`}>
      {delta > 0 ? "+" : ""}{formatBytes(Math.abs(delta))}
    </div>
  );
}

function FileDeltaCount({ prev, curr }: { prev: number; curr: number }) {
  const d = curr - prev;
  if (d === 0) return null;
  return (
    <span className="changes-row-file-delta">
      ({d > 0 ? "+" : ""}{d} files)
    </span>
  );
}

// ── Helpers ────────────────────────────────────────────────

function badgeClass(kind: string): string {
  switch (kind) {
    case "added": return "added";
    case "removed": return "removed";
    case "grew": return "grew";
    case "shrank": return "shrank";
    default: return "";
  }
}

function formatTimeBetween(ms: number): string {
  if (ms <= 0) return "—";
  const mins = Math.floor(ms / 60_000);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ${mins % 60}m`;
  const days = Math.floor(hours / 24);
  return `${days}d ${hours % 24}h`;
}

// ── Full diff list (sourced from the persisted file index) ──

function FullDiffList({ diff, busy, onReveal, onOpen, onTrash, onEasyMove, onShowTopN }: {
  diff: FullDiffResult;
  busy: Set<string>;
  onReveal: (path: string) => void;
  onOpen: (path: string) => void;
  onTrash: (path: string) => void;
  onEasyMove: (path: string) => void;
  onShowTopN: () => void;
}) {
  return (
    <>
      <div className="changes-full-diff-header">
        <div className="changes-full-diff-stats">
          <span>
            <strong>{diff.totalChanges.toLocaleString()}</strong> total
          </span>
          {diff.totalAdded > 0 && <span className="added">+{diff.totalAdded.toLocaleString()} added</span>}
          {diff.totalGrew > 0 && <span className="grew">{diff.totalGrew.toLocaleString()} grew</span>}
          {diff.totalShrank > 0 && <span className="shrank">{diff.totalShrank.toLocaleString()} shrank</span>}
          {diff.totalRemoved > 0 && <span className="removed">−{diff.totalRemoved.toLocaleString()} removed</span>}
        </div>
        <button className="action-btn" onClick={onShowTopN}>Back to top-N</button>
      </div>
      {diff.truncated && (
        <div className="changes-caveat">
          Showing the top {diff.changes.length.toLocaleString()} changes by impact.
          {diff.totalChanges - diff.changes.length > 0 && ` ${(diff.totalChanges - diff.changes.length).toLocaleString()} more exist in the index.`}
        </div>
      )}
      {diff.changes.length === 0 && (
        <div className="changes-empty-detail">No file-level changes detected</div>
      )}
      {diff.changes.map((change: FullFileChange) => {
        const isBusy = busy.has(change.path);
        const isActionable = change.kind !== "removed";
        const name = change.path.split(/[\\/]/).pop() ?? change.path;
        return (
          <div key={change.path} className="changes-row">
            <div className={`changes-row-badge ${change.kind}`}>{change.kind}</div>
            <div className="changes-row-info">
              <div className="changes-row-name">{name}</div>
              <div className="changes-row-path">{change.path}</div>
            </div>
            <div className={`changes-row-delta ${change.deltaBytes <= 0 ? "positive" : "negative"}`}>
              {change.deltaBytes > 0 ? "+" : ""}{formatBytes(Math.abs(change.deltaBytes))}
            </div>
            <div className="changes-row-sizes">
              {change.kind === "added" ? (
                <span>{formatBytes(change.size)}</span>
              ) : change.kind === "removed" ? (
                <span className="changes-row-prev">{formatBytes(change.previousSize)}</span>
              ) : (
                <>
                  <span className="changes-row-prev">{formatBytes(change.previousSize)}</span>
                  <span className="changes-row-arrow">&rarr;</span>
                  <span>{formatBytes(change.size)}</span>
                </>
              )}
            </div>
            {isActionable && (
              <div className="changes-row-actions">
                <button className="action-btn" disabled={isBusy} onClick={() => onReveal(change.path)}>Reveal</button>
                <button className="action-btn" disabled={isBusy} onClick={() => onOpen(change.path)}>Open</button>
                <button className="action-btn warn" disabled={isBusy} onClick={() => onTrash(change.path)}>Trash</button>
                <button className="action-btn" disabled={isBusy} onClick={() => onEasyMove(change.path)}>Move</button>
              </div>
            )}
          </div>
        );
      })}
    </>
  );
}

