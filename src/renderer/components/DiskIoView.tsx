import { useCallback, useEffect, useMemo, useState } from "preact/hooks";

import type { DiskIoProcessInfo, DiskIoSnapshot } from "../../shared/contracts";
import { formatBytes, relativeTime } from "../lib/format";
import { nativeApi } from "../nativeApi";
import { ProcessIcon } from "./ProcessIcon";
import { toast } from "./Toasts";

type SortField = "total" | "read" | "write" | "name" | "pid";
type SortDir = "asc" | "desc";

const REFRESH_MS = 2_000;

export function DiskIoView() {
  const [snapshot, setSnapshot] = useState<DiskIoSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [paused, setPaused] = useState(false);
  const [filter, setFilter] = useState("");
  const [sortField, setSortField] = useState<SortField>("total");
  const [sortDir, setSortDir] = useState<SortDir>("desc");

  const refresh = useCallback(async () => {
    const snap = await nativeApi.getDiskIoSnapshot();
    setSnapshot(snap);
    setLoading(false);
  }, []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const cached = await nativeApi.getCachedDiskIoSnapshot();
      if (!cancelled && cached) {
        setSnapshot(cached);
        setLoading(false);
      }
      const fresh = await nativeApi.getDiskIoSnapshot();
      if (!cancelled) {
        setSnapshot(fresh);
        setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (paused) return;
    const id = window.setInterval(() => void refresh(), REFRESH_MS);
    return () => window.clearInterval(id);
  }, [paused, refresh]);

  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase();
    const rows = (snapshot?.processes ?? []).filter((p) => {
      if (!q) return true;
      return (
        p.name.toLowerCase().includes(q) ||
        String(p.pid).includes(q) ||
        (p.exePath ?? "").toLowerCase().includes(q) ||
        (p.commandLine ?? "").toLowerCase().includes(q)
      );
    });

    const dir = sortDir === "asc" ? 1 : -1;
    rows.sort((a, b) => {
      switch (sortField) {
        case "read": return (a.readBytesPerSec - b.readBytesPerSec) * dir;
        case "write": return (a.writeBytesPerSec - b.writeBytesPerSec) * dir;
        case "name": return a.name.localeCompare(b.name) * dir;
        case "pid": return (a.pid - b.pid) * dir;
        default: return (a.totalBytesPerSec - b.totalBytesPerSec) * dir;
      }
    });
    return rows;
  }, [filter, snapshot?.processes, sortDir, sortField]);

  const maxRate = Math.max(1, ...filtered.map((p) => p.totalBytesPerSec));
  const totalRate = (snapshot?.totalReadBytesPerSec ?? 0) + (snapshot?.totalWriteBytesPerSec ?? 0);
  const busiest = snapshot?.hasRateBaseline
    ? (snapshot.processes ?? []).reduce<DiskIoProcessInfo | null>(
      (best, process) => process.totalBytesPerSec > (best?.totalBytesPerSec ?? 0) ? process : best,
      null,
    )
    : null;

  const setSort = (field: SortField) => {
    if (sortField === field) {
      setSortDir((d) => d === "asc" ? "desc" : "asc");
    } else {
      setSortField(field);
      setSortDir(field === "name" ? "asc" : "desc");
    }
  };

  if (loading && !snapshot) {
    return (
      <div className="diskio-view">
        <div className="diskio-empty">
          <div className="diskio-spinner" />
          <div className="diskio-empty-title">Sampling process I/O</div>
          <div className="diskio-empty-sub">Collecting the first read/write counters.</div>
        </div>
      </div>
    );
  }

  if (snapshot?.unavailable) {
    return (
      <div className="diskio-view">
        <div className="diskio-empty">
          <div className="diskio-empty-icon">I/O</div>
          <div className="diskio-empty-title">Per-process disk I/O is not available on this platform</div>
          <div className="diskio-empty-sub">{snapshot.platformNote}</div>
        </div>
      </div>
    );
  }

  return (
    <div className="diskio-view">
      <div className="diskio-header">
        <div>
          <div className="diskio-title">Per-process Disk I/O</div>
          <div className="diskio-subtitle">
            Live read/write throughput by process. {snapshot?.platformNote}
          </div>
        </div>
        <div className="diskio-actions">
          <button type="button" className={`action-btn ${paused ? "primary" : ""}`} onClick={() => setPaused((v) => !v)}>
            {paused ? "Resume" : "Pause"}
          </button>
          <button type="button" className="action-btn" onClick={() => void refresh()}>Refresh</button>
        </div>
      </div>

      <div className="diskio-summary">
        <DiskIoMetric label="total" value={`${formatBytes(totalRate)}/s`} accent />
        <DiskIoMetric label="read" value={`${formatBytes(snapshot?.totalReadBytesPerSec ?? 0)}/s`} />
        <DiskIoMetric label="write" value={`${formatBytes(snapshot?.totalWriteBytesPerSec ?? 0)}/s`} />
        <DiskIoMetric
          label="busiest"
          value={busiest ? busiest.name : snapshot?.hasRateBaseline ? "idle" : "baseline"}
          title={busiest ? `${formatBytes(busiest.totalBytesPerSec)}/s` : undefined}
        />
      </div>

      <div className="diskio-toolbar">
        <input
          className="filter-input"
          value={filter}
          onInput={(e) => setFilter((e.target as HTMLInputElement).value)}
          placeholder="Filter by process, PID, or path..."
        />
        <div className="diskio-toolbar-meta">
          {snapshot?.isStale ? "cached" : snapshot ? `sampled ${relativeTime(snapshot.sampledAt)}` : ""}
          {snapshot?.sampleElapsedMs ? ` - ${snapshot.sampleElapsedMs}ms` : ""}
          {!snapshot?.hasRateBaseline && " - collecting rate baseline"}
          {snapshot?.errorMessage ? ` - ${snapshot.errorMessage}` : ""}
        </div>
      </div>

      <div className="diskio-table">
        <div className="diskio-table-head">
          <div />
          <button type="button" onClick={() => setSort("name")}>Process</button>
          <button type="button" onClick={() => setSort("read")}>Read/s</button>
          <button type="button" onClick={() => setSort("write")}>Write/s</button>
          <button type="button" onClick={() => setSort("total")}>Total/s</button>
          <button type="button" onClick={() => setSort("pid")}>PID</button>
        </div>
        <div className="diskio-table-scroll">
          {filtered.length === 0 ? (
            <div className="diskio-empty-inline">
              {snapshot?.hasRateBaseline
                ? "No process I/O above zero in the current sample."
                : "First sample captured. Rates appear on the next refresh."}
            </div>
          ) : (
            filtered.map((process) => (
              <DiskIoRow key={process.pid} process={process} maxRate={maxRate} />
            ))
          )}
        </div>
      </div>
    </div>
  );
}

function DiskIoMetric({ label, value, accent, title }: {
  label: string;
  value: string;
  accent?: boolean;
  title?: string;
}) {
  return (
    <div className="diskio-metric" title={title}>
      <div className={`diskio-metric-value ${accent ? "accent" : ""}`}>{value}</div>
      <div className="diskio-metric-label">{label}</div>
    </div>
  );
}

function DiskIoRow({ process, maxRate }: { process: DiskIoProcessInfo; maxRate: number }) {
  const pct = process.totalBytesPerSec > 0
    ? Math.max(2, Math.min(100, (process.totalBytesPerSec / maxRate) * 100))
    : 0;
  const readPct = process.totalBytesPerSec > 0
    ? (process.readBytesPerSec / process.totalBytesPerSec) * 100
    : 0;
  return (
    <div className="diskio-row" title={process.exePath ?? process.commandLine ?? process.name}>
      <ProcessIcon exePath={process.exePath} className="diskio-row-icon" />
      <div className="diskio-row-process">
        <div className="diskio-row-name">{process.name}</div>
        <div className="diskio-row-path">{process.exePath ?? process.commandLine ?? "path unavailable"}</div>
      </div>
      <div className="diskio-row-rate read">{formatBytes(process.readBytesPerSec)}/s</div>
      <div className="diskio-row-rate write">{formatBytes(process.writeBytesPerSec)}/s</div>
      <div className="diskio-row-total">
        <span>{formatBytes(process.totalBytesPerSec)}/s</span>
        <div className="diskio-row-bar">
          <div className="diskio-row-bar-fill" style={{ width: `${pct}%` }}>
            <div className="diskio-row-bar-read" style={{ width: `${readPct}%` }} />
          </div>
        </div>
      </div>
      <div className="diskio-row-pid">
        <span>{process.pid}</span>
        {process.exePath && (
          <button
            type="button"
            className="diskio-row-reveal"
            title="Reveal executable"
            onClick={async () => {
              const result = await nativeApi.revealPath(process.exePath!);
              if (!result?.ok) toast("warning", "Couldn't reveal executable", result?.message);
            }}
          >
            <svg width="11" height="11" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.4">
              <path d="M1.5 3.5V11.5C1.5 12.05 1.95 12.5 2.5 12.5H11.5C12.05 12.5 12.5 12.05 12.5 11.5V5.5C12.5 4.95 12.05 4.5 11.5 4.5H7L5.5 2.5H2.5C1.95 2.5 1.5 2.95 1.5 3.5Z" />
            </svg>
          </button>
        )}
      </div>
    </div>
  );
}
