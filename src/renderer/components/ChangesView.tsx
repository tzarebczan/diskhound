import { useCallback, useEffect, useMemo, useRef, useState } from "preact/hooks";

import type {
  DirectoryDelta,
  FileDelta,
  FullDiffStatus,
  FullDiffResult,
  FullFileChange,
  ScanDiffResult,
  ScanEngine,
  ScanHistoryEntry,
  ScanScheduleInfo,
  ScanSnapshot,
} from "../../shared/contracts";
import { basename, formatBytes, relativeTime } from "../lib/format";
import { usePathActions } from "../lib/hooks";
import { nativeApi } from "../nativeApi";
import { toast } from "./Toasts";
import { FileIcon } from "./FileIcon";

interface Props {
  rootPath: string | null;
  /** The live snapshot — used to detect scan completions for auto-refresh. */
  snapshot: ScanSnapshot;
}

type DetailTab = "files" | "directories";

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

const FULL_DIFF_AUTOLOAD_MAX_BYTES = 64 * 1024 * 1024;

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
  const [fullDiffStatus, setFullDiffStatus] = useState<FullDiffStatus | null>(null);
  const [fullDiffLoading, setFullDiffLoading] = useState(false);
  const [scheduleInfo, setScheduleInfo] = useState<ScanScheduleInfo | null>(null);
  const [enablingMonitoring, setEnablingMonitoring] = useState(false);
  const { busy, runAction, handleEasyMove } = usePathActions();
  const prevStatusRef = useRef(snapshot.status);
  const fullDiffSeqRef = useRef(0);

  // Schedule info: fetch on mount + refresh every 30s so the "next scan in X"
  // label stays roughly current. Also refresh after scans complete.
  const refreshScheduleInfo = useCallback(async () => {
    const info = await nativeApi.getScanScheduleInfo();
    if (info) setScheduleInfo(info);
  }, []);

  useEffect(() => {
    void refreshScheduleInfo();
    const id = window.setInterval(() => { void refreshScheduleInfo(); }, 30_000);
    return () => window.clearInterval(id);
  }, [refreshScheduleInfo]);

  const monitoringEnabled = scheduleInfo?.enabled ?? null;

  // Renderer-side diff cache. Keyed "<baselineId>::<currentId>" so flicking
  // back to a previously viewed baseline is instant. Pruned to the most
  // recent N entries so we don't grow unbounded for users with long history.
  const diffCache = useRef<Map<string, ScanDiffResult>>(new Map());
  const DIFF_CACHE_LIMIT = 16;

  const cacheDiff = useCallback((d: ScanDiffResult) => {
    const key = `${d.baselineId}::${d.currentId}`;
    diffCache.current.set(key, d);
    while (diffCache.current.size > DIFF_CACHE_LIMIT) {
      const firstKey = diffCache.current.keys().next().value;
      if (firstKey) diffCache.current.delete(firstKey);
      else break;
    }
  }, []);

  // Scan from within the Changes tab — either runs the scheduled job immediately
  // or falls back to a direct rescan of the current root.
  const rescanNow = useCallback(async () => {
    if (snapshot.status === "running") {
      toast("info", "Scan already in progress");
      return;
    }
    const targetPath = scheduleInfo?.defaultRootPath || rootPath;
    if (!targetPath) {
      toast("warning", "Pick a root first from the Overview tab.");
      return;
    }
    const result = await nativeApi.startScan(targetPath, {});
    if (result?.status === "error") {
      toast("error", "Rescan failed", result.errorMessage ?? "Unknown error");
    }
    void refreshScheduleInfo();
  }, [rootPath, scheduleInfo?.defaultRootPath, snapshot.status, refreshScheduleInfo]);

  const enableMonitoring = useCallback(async () => {
    setEnablingMonitoring(true);
    try {
      const s = await nativeApi.getSettings();
      if (!s) return;
      await nativeApi.updateSettings({
        ...s,
        monitoring: { ...s.monitoring, enabled: true },
      });
      toast(
        "success",
        "Background monitoring enabled",
        `DiskHound will rescan every ${s.monitoring.fullScanIntervalMinutes || 60} min and keep adding snapshots for later diffs.`,
      );
      await refreshScheduleInfo();
    } finally {
      setEnablingMonitoring(false);
    }
  }, [refreshScheduleInfo]);

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
      fullDiffSeqRef.current += 1;
      setFullDiff(null);
      setFullDiffStatus(null);
      setFullDiffLoading(false);
      setFullDiffError(null);
      setLoading(false);
      return;
    }

    let cancelled = false;
    setLoading(true);
    setHistory([]);
    setDiff(null);
    setSelectedBaseline(null);
    setActiveQuickSelect(null);
    fullDiffSeqRef.current += 1;
    setFullDiff(null);
    setFullDiffStatus(null);
    setFullDiffLoading(false);

    void (async () => {
      const data = await loadData(rootPath);
      if (cancelled) return;
      if (data.history) setHistory(data.history);
      if (data.diff) {
        cacheDiff(data.diff);
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
  }, [rootPath, loadData, cacheDiff]);

  // Auto-refresh when a scan completes (status transitions to "done")
  useEffect(() => {
    const prevStatus = prevStatusRef.current;
    prevStatusRef.current = snapshot.status;

    if (prevStatus !== "done" && snapshot.status === "done" && rootPath) {
      // Scan just finished — reload history + diff and refresh schedule info.
      // Invalidate the renderer-side diff cache; some entries may now be
      // stale (e.g. the "current" pointer has moved to the new scan).
      diffCache.current.clear();
      void (async () => {
        const data = await loadData(rootPath);
        if (data.history) setHistory(data.history);
        if (data.diff) {
          cacheDiff(data.diff);
          setDiff(data.diff);
          setSelectedBaseline(data.diff.baselineId);
          const matchingQuickSelect = TIME_RANGES
            .map((range) => resolveTimeRange(range, data.history))
            .find((resolved) => resolved.entry?.id === data.diff!.baselineId);
          setActiveQuickSelect(matchingQuickSelect?.range.id ?? null);
        }
        await refreshScheduleInfo();
      })();
    }
  }, [snapshot.status, rootPath, loadData, refreshScheduleInfo, cacheDiff]);

  // Compare against a different baseline. Critical: we never blank the
  // screen while waiting for the diff. We optimistically swap to a cached
  // result if available, else show the previous diff with a subtle
  // "switching" overlay until the new result lands.
  const switchSeqRef = useRef(0);
  const [switching, setSwitching] = useState(false);
  const selectBaseline = async (baselineId: string) => {
    if (!history.length) return;
    const currentId = history[0].id;
    setSelectedBaseline(baselineId);
    fullDiffSeqRef.current += 1;
    setFullDiff(null); // invalidate — applies to different baseline now
    setFullDiffStatus(null);
    setFullDiffLoading(false);
    setFullDiffError(null);

    const cacheKey = `${baselineId}::${currentId}`;
    const cached = diffCache.current.get(cacheKey);
    if (cached) {
      setDiff(cached);
      return; // instant — no IPC needed
    }

    // Bump a sequence so a slow IPC for a previous baseline doesn't
    // overwrite a fresher selection.
    const seq = ++switchSeqRef.current;
    setSwitching(true);
    const d = await nativeApi.computeScanDiff(baselineId, currentId);
    if (seq !== switchSeqRef.current) return; // stale — user switched again
    if (d) {
      cacheDiff(d);
      setDiff(d);
    }
    setSwitching(false);
  };

  const [fullDiffError, setFullDiffError] = useState<string | null>(null);
  const loadFullDiff = useCallback(async () => {
    if (!diff) return;
    const seq = ++fullDiffSeqRef.current;
    const baselineId = diff.baselineId;
    const currentId = diff.currentId;
    setFullDiffLoading(true);
    setFullDiffError(null);
    try {
      const result = await nativeApi.computeFullScanDiff(baselineId, currentId, 1000);
      if (seq !== fullDiffSeqRef.current) return;
      if (result) {
        setFullDiff(result);
      } else {
        // Null result means the main process couldn't produce a diff —
        // usually because one of the indexes is missing or unreadable.
        // Surface that instead of silently flipping the UI back to
        // the "Load full file diff" CTA, which looked identical to
        // the pre-load state and felt like a hang to users.
        setFullDiffError(
          "Couldn't compute the full diff. One of the scan indexes may be missing or in use. See crash.log for details.",
        );
      }
    } catch (err) {
      if (seq !== fullDiffSeqRef.current) return;
      setFullDiffError(
        err instanceof Error ? err.message : "Unknown error computing full diff",
      );
    } finally {
      if (seq === fullDiffSeqRef.current) {
        setFullDiffLoading(false);
      }
    }
  }, [diff]);

  useEffect(() => {
    if (!diff) {
      setFullDiffStatus(null);
      return;
    }

    let cancelled = false;
    setFullDiffStatus(null);
    void nativeApi.getFullDiffStatus(diff.baselineId, diff.currentId, 1000).then((status) => {
      if (!cancelled) {
        setFullDiffStatus(status);
      }
    });

    return () => {
      cancelled = true;
    };
  }, [diff?.baselineId, diff?.currentId]);

  const fullDiffCombinedBytes = useMemo(() => {
    if (!fullDiffStatus) return null;
    if (fullDiffStatus.baselineIndexBytes === null || fullDiffStatus.currentIndexBytes === null) {
      return null;
    }
    return fullDiffStatus.baselineIndexBytes + fullDiffStatus.currentIndexBytes;
  }, [fullDiffStatus]);

  const shouldAutoLoadFullDiff = Boolean(
    fullDiffStatus?.cached
      || (fullDiffCombinedBytes !== null && fullDiffCombinedBytes <= FULL_DIFF_AUTOLOAD_MAX_BYTES),
  );

  // Auto-load the full per-file diff whenever a new baseline/current pair is
  // selected when it's already cached or small enough to resolve quickly.
  // Large uncached pairs fall back to the fast top-N summary first so the
  // tab stays responsive on multi-million-file scans.
  useEffect(() => {
    if (!diff || detailTab !== "files" || !shouldAutoLoadFullDiff) return;
    // Don't refetch if we already have the matching full diff loaded.
    if (fullDiff && fullDiff.baselineId === diff.baselineId && fullDiff.currentId === diff.currentId) return;
    void loadFullDiff();
  }, [detailTab, diff, fullDiff, loadFullDiff, shouldAutoLoadFullDiff]);

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
        <ScheduleStatusStrip
          info={scheduleInfo}
          isScanning={snapshot.status === "running"}
          onRescan={() => void rescanNow()}
          onEnableMonitoring={() => void enableMonitoring()}
          enablingMonitoring={enablingMonitoring}
        />
        <div className="changes-empty">
          <div className="changes-empty-icon">
            <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1" opacity="0.3">
              <path d="M12 8V12L15 15" />
              <circle cx="12" cy="12" r="9" />
            </svg>
          </div>
          <div className="changes-empty-text">No previous scan to compare</div>
          <div className="changes-empty-hint">
            {history.length === 1 ? "One scan recorded so far." : "Run a scan of this path first."}
          </div>
          <div className="changes-empty-paths">
            <div className="changes-empty-path-title">How to get diffs</div>
            <ol className="changes-empty-path-list">
              <li><strong>Hit "Rescan now"</strong> above — each completed scan adds a history entry, then DiskHound compares it with the previous one.</li>
              <li>
                <strong>Background monitoring</strong> rescans your default path on a schedule (1h by default). On supported NTFS volumes, some follow-up scans can use the Windows change journal; other paths keep using scheduled rescans.{" "}
                {monitoringEnabled === false && "It's currently off — use the banner above to turn it on."}
                {monitoringEnabled === true && "Already on — new snapshots will keep landing in the background."}
              </li>
            </ol>
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

  const isScanning = snapshot.status === "running";
  const showManualFullDiffCta =
    detailTab === "files"
    && !fullDiff
    && !fullDiffLoading
    && !!fullDiffStatus
    && !shouldAutoLoadFullDiff;

  return (
    <div className={`changes-view ${switching ? "is-switching" : ""}`}>
      <ScheduleStatusStrip
        info={scheduleInfo}
        isScanning={isScanning}
        onRescan={() => void rescanNow()}
        onEnableMonitoring={() => void enableMonitoring()}
        enablingMonitoring={enablingMonitoring}
      />
      {switching && (
        <div className="changes-switching-bar" aria-hidden="true">
          <div className="changes-switching-bar-fill" />
        </div>
      )}

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

              // The latest scan is the "current" side of the diff — not clickable,
              // render as a static header that clearly differs from the list items.
              if (isLatest) {
                return (
                  <div key={h.id} className="changes-history-current">
                    <div className="changes-history-current-label">COMPARING AGAINST</div>
                    <div className="changes-history-date">
                      {relativeTime(h.scannedAt)}
                      <span className="changes-history-badge">current</span>
                      <EngineBadge engine={h.engine} />
                    </div>
                    <div className="changes-history-meta">
                      <span>{formatBytes(h.bytesSeen)}</span>
                      <span>{h.filesVisited.toLocaleString()} files</span>
                    </div>
                  </div>
                );
              }

              return (
                <button
                  key={h.id}
                  className={`changes-history-item ${isSelected ? "selected" : ""}`}
                  onClick={() => {
                    setActiveQuickSelect(null);
                    void selectBaseline(h.id);
                  }}
                  title="Compare against this scan"
                >
                  <div className="changes-history-date">
                    {relativeTime(h.scannedAt)}
                    <EngineBadge engine={h.engine} />
                  </div>
                  <div className="changes-history-meta">
                    <span>{formatBytes(h.bytesSeen)}</span>
                    <span>{h.filesVisited.toLocaleString()} files</span>
                  </div>
                  {sizeDelta !== 0 && (
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
          </div>

          {/* Detail list */}
          <div className="changes-detail-scroll">
            {detailTab === "files" && fullDiff && fullDiff.totalChanges > 0 && (
              <FullDiffList
                diff={fullDiff}
                busy={busy}
                onReveal={(p) => void runAction(p, () => nativeApi.revealPath(p))}
                onOpen={(p) => void runAction(p, () => nativeApi.openPath(p))}
                onTrash={(p) => void runAction(p, () => nativeApi.trashPath(p))}
                onEasyMove={(p) => void handleEasyMove(p)}
              />
            )}
            {detailTab === "files" && fullDiff && fullDiff.totalChanges === 0 && (
              <div className="changes-empty-detail">
                <div className="changes-empty-detail-title">No file-level changes</div>
                <div className="changes-empty-detail-hint">
                  Both scans saw the same files at the same sizes. Aggregate
                  totals above confirm — {formatBytes(Math.abs(diff.totalBytesDelta))} net change.
                </div>
              </div>
            )}
            {detailTab === "files" && !fullDiff && fullDiffLoading && (
              <div className="changes-empty-detail">
                <div className="changes-empty-detail-title">Loading changes…</div>
                <div className="changes-empty-detail-hint">
                  Reading the persisted index for this diff.
                </div>
              </div>
            )}
            {detailTab === "files" && !fullDiff && !fullDiffLoading && (
              <>
                {fullDiffError && (
                  <div className="changes-full-diff-cta changes-full-diff-cta-error" role="alert">
                    <div className="changes-full-diff-copy">
                      <div className="changes-full-diff-title">Full diff didn't complete</div>
                      <div className="changes-full-diff-hint">{fullDiffError}</div>
                    </div>
                    <button className="action-btn" onClick={() => void loadFullDiff()}>
                      Retry
                    </button>
                  </div>
                )}
                {!fullDiffError && showManualFullDiffCta && (
                  <div className="changes-full-diff-cta">
                    <div className="changes-full-diff-copy">
                      <div className="changes-full-diff-title">Showing the fast summary first</div>
                      <div className="changes-full-diff-hint">
                        {fullDiffCombinedBytes !== null
                          ? `This pair needs to read ${formatBytes(fullDiffCombinedBytes)} of persisted index data the first time.`
                          : "This pair needs the persisted file indexes to build the full-file diff the first time."}
                      </div>
                    </div>
                    <button className="action-btn" onClick={() => void loadFullDiff()}>
                      Load full file diff
                    </button>
                  </div>
                )}
                <FileDeltaList
                  deltas={diff.fileDeltas}
                  busy={busy}
                  onReveal={(p) => void runAction(p, () => nativeApi.revealPath(p))}
                  onOpen={(p) => void runAction(p, () => nativeApi.openPath(p))}
                  onTrash={(p) => void runAction(p, () => nativeApi.trashPath(p))}
                  onEasyMove={(p) => void handleEasyMove(p)}
                />
              </>
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
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Sub-components ─────────────────────────────────────────

/**
 * Top-of-Changes-tab strip that makes the scanning schedule legible: when the
 * last scan happened, when the next is due, and one-click actions (Rescan now
 * + Enable monitoring). The first thing users should see when they open the
 * tab and wonder "why aren't there any new changes?"
 */
function ScheduleStatusStrip({
  info,
  isScanning,
  onRescan,
  onEnableMonitoring,
  enablingMonitoring,
}: {
  info: ScanScheduleInfo | null;
  isScanning: boolean;
  onRescan: () => void;
  onEnableMonitoring: () => void;
  enablingMonitoring: boolean;
}) {
  if (!info) {
    // Fetching — render a lightweight placeholder so layout doesn't shift.
    return <div className="changes-schedule-strip changes-schedule-strip-loading" aria-hidden="true" />;
  }

  const lastLabel = info.lastScanAt ? relativeTime(info.lastScanAt) : "never";

  let nextLabel: string;
  if (isScanning) {
    nextLabel = "scanning now…";
  } else if (!info.enabled) {
    nextLabel = "monitoring off";
  } else if (info.intervalMinutes === 0) {
    nextLabel = "auto-rescan disabled";
  } else if (info.nextScanAt === null) {
    nextLabel = `every ${formatScanIntervalMinutes(info.intervalMinutes)}`;
  } else {
    const msUntil = info.nextScanAt - Date.now();
    nextLabel = msUntil <= 0 ? "due now" : `in ${formatDurationMs(msUntil)}`;
  }

  const showEnableCta = info.enabled === false;

  return (
    <div className={`changes-schedule-strip ${showEnableCta ? "attention" : ""}`}>
      {showEnableCta ? (
        <div className="changes-schedule-banner">
          <div className="changes-schedule-banner-text">
            <strong>Background monitoring is off.</strong>{" "}
            Turn it on to keep adding scheduled snapshots for this path. On supported NTFS volumes, some follow-up scans can use journal-based incremental updates.
          </div>
          <button
            className="action-btn"
            disabled={enablingMonitoring}
            onClick={onEnableMonitoring}
          >
            {enablingMonitoring ? "Enabling…" : "Enable monitoring"}
          </button>
        </div>
      ) : (
        <div className="changes-schedule-status">
          <div className="changes-schedule-meta">
            <span className="changes-schedule-label">Last scan</span>
            <span className="changes-schedule-value">{lastLabel}</span>
          </div>
          <div className="changes-schedule-divider" />
          <div className="changes-schedule-meta">
            <span className="changes-schedule-label">Next scan</span>
            <span className="changes-schedule-value">{nextLabel}</span>
          </div>
        </div>
      )}
      <div className="changes-schedule-spacer" />
      <button
        className="action-btn"
        disabled={isScanning}
        onClick={onRescan}
        title="Run a fresh scan of your default path now"
      >
        {isScanning ? "Scanning…" : "Rescan now"}
      </button>
    </div>
  );
}

/**
 * Compact icon surfacing how a snapshot in history was produced.
 *
 * - Delta (USN journal): lightning bolt — near-instant incremental read of
 *   the NTFS change log. Very fast but only sees events since the previous
 *   anchor, so it's slightly estimate-y: files that changed via paths we
 *   couldn't resolve are missed until the next full scan.
 * - Full: stacked-layers glyph — walked the whole tree, definitive
 *   numbers. Slower but authoritative.
 * - Unknown engine (pre-v0.2.8 history): render nothing.
 *
 * Icon-only by design — "fast"/"full" text gets noisy when every row
 * has one. The tooltip surfaces the detail on hover.
 */
function EngineBadge({ engine }: { engine?: ScanEngine }) {
  if (engine === "usn-journal") {
    return (
      <span
        className="changes-engine-icon delta"
        title="Delta scan — changes since the previous snapshot, read from the NTFS journal. Near-instant but estimate-y: files we couldn't resolve are missed until the next full scan."
        aria-label="Delta scan"
      >
        <svg width="10" height="10" viewBox="0 0 12 12" fill="currentColor" aria-hidden="true">
          <path d="M7 0L2 7H5L4 12L10 5H7L7 0Z" />
        </svg>
      </span>
    );
  }
  if (engine === "native-sidecar" || engine === "js-worker") {
    return (
      <span
        className="changes-engine-icon full"
        title="Full scan — walked the entire tree. Authoritative numbers, but slower than a delta."
        aria-label="Full scan"
      >
        <svg width="10" height="10" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true">
          <rect x="1.5" y="1.5" width="9" height="5" rx="0.5" />
          <rect x="1.5" y="5.5" width="9" height="5" rx="0.5" />
        </svg>
      </span>
    );
  }
  return null;
}

function formatScanIntervalMinutes(minutes: number): string {
  if (minutes < 60) return `${minutes}m`;
  const hours = minutes / 60;
  if (hours < 24) return Number.isInteger(hours) ? `${hours}h` : `${hours.toFixed(1)}h`;
  const days = hours / 24;
  return Number.isInteger(days) ? `${days}d` : `${days.toFixed(1)}d`;
}

function formatDurationMs(ms: number): string {
  const totalMin = Math.max(0, Math.round(ms / 60_000));
  if (totalMin < 60) return `${totalMin}m`;
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (h < 24) return m > 0 ? `${h}h ${m}m` : `${h}h`;
  const d = Math.floor(h / 24);
  return `${d}d ${h % 24}h`;
}

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
            <FileIcon path={d.path} className="changes-row-file-icon" />
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

function FullDiffList({ diff, busy, onReveal, onOpen, onTrash, onEasyMove }: {
  diff: FullDiffResult;
  busy: Set<string>;
  onReveal: (path: string) => void;
  onOpen: (path: string) => void;
  onTrash: (path: string) => void;
  onEasyMove: (path: string) => void;
}) {
  const [filter, setFilter] = useState("");

  const visibleChanges = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return diff.changes;
    return diff.changes.filter((c) => c.path.toLowerCase().includes(q));
  }, [diff.changes, filter]);

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
        <div className="changes-full-diff-controls">
          <input
            className="filter-input"
            value={filter}
            onInput={(e) => setFilter((e.target as HTMLInputElement).value)}
            placeholder="Filter by path..."
          />
        </div>
      </div>
      {diff.truncated && !filter && (
        <div className="changes-caveat">
          Showing the top {diff.changes.length.toLocaleString()} changes by impact.
          {diff.totalChanges - diff.changes.length > 0 && ` ${(diff.totalChanges - diff.changes.length).toLocaleString()} more exist in the index.`}
        </div>
      )}
      {filter && (
        <div className="changes-caveat">
          {visibleChanges.length.toLocaleString()} match{visibleChanges.length !== 1 ? "es" : ""} for "{filter}"
        </div>
      )}
      {visibleChanges.length === 0 && (
        <div className="changes-empty-detail">
          {filter ? "No matches" : "No file-level changes detected"}
        </div>
      )}
      {visibleChanges.map((change: FullFileChange) => {
        const isBusy = busy.has(change.path);
        const isActionable = change.kind !== "removed";
        const name = change.path.split(/[\\/]/).pop() ?? change.path;
        return (
          <div key={change.path} className="changes-row">
            <div className={`changes-row-badge ${change.kind}`}>{change.kind}</div>
            <FileIcon path={change.path} className="changes-row-file-icon" />
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

