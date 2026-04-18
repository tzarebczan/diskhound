import { useCallback, useEffect, useMemo, useRef, useState } from "preact/hooks";

import type { ProcessInfo, SystemMemorySnapshot } from "../../shared/contracts";
import { formatBytes, formatCount } from "../lib/format";
import { nativeApi } from "../nativeApi";
import { toast } from "./Toasts";

type SortField = "memory" | "cpu" | "name" | "pid";
type SortDir = "asc" | "desc";

const REFRESH_MS = 2500;

export function MemoryView() {
  const [snapshot, setSnapshot] = useState<SystemMemorySnapshot | null>(null);
  const [filter, setFilter] = useState("");
  const [sortField, setSortField] = useState<SortField>("memory");
  const [sortDir, setSortDir] = useState<SortDir>("desc");
  const [killingPid, setKillingPid] = useState<number | null>(null);
  const [paused, setPaused] = useState(false);
  const timerRef = useRef<number | null>(null);

  // Poll system memory on an interval
  const refresh = useCallback(async () => {
    const snap = await nativeApi.getMemorySnapshot();
    if (snap) setSnapshot(snap);
  }, []);

  useEffect(() => {
    void refresh();
    if (paused) return;
    timerRef.current = window.setInterval(() => void refresh(), REFRESH_MS);
    return () => {
      if (timerRef.current !== null) window.clearInterval(timerRef.current);
    };
  }, [paused, refresh]);

  // Pause polling when window is hidden (saves CPU)
  useEffect(() => {
    const onVis = () => setPaused(document.hidden);
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, []);

  const toggleSort = (field: SortField) => {
    if (sortField === field) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortField(field);
      setSortDir(field === "name" ? "asc" : "desc");
    }
  };

  const visibleProcesses = useMemo(() => {
    if (!snapshot) return [];
    const q = filter.trim().toLowerCase();
    let list = q
      ? snapshot.processes.filter((p) => p.name.toLowerCase().includes(q) || String(p.pid).includes(q))
      : snapshot.processes;

    const m = sortDir === "asc" ? 1 : -1;
    list = [...list].sort((a, b) => {
      switch (sortField) {
        case "memory": return (a.memoryBytes - b.memoryBytes) * m;
        case "cpu":    return ((a.cpuPercent ?? 0) - (b.cpuPercent ?? 0)) * m;
        case "name":   return a.name.localeCompare(b.name) * m;
        case "pid":    return (a.pid - b.pid) * m;
      }
    });

    return list;
  }, [snapshot, filter, sortField, sortDir]);

  const kill = async (proc: ProcessInfo, hard: boolean) => {
    const label = hard ? "Force kill" : "End";
    if (!confirm(`${label} ${proc.name} (PID ${proc.pid})?\n\nThis will terminate the process immediately.`)) return;
    setKillingPid(proc.pid);
    const r = await nativeApi.killProcess(proc.pid, hard ? "hard" : "soft");
    setKillingPid(null);
    if (r?.ok) {
      toast("success", `Terminated ${proc.name}`, `PID ${proc.pid}`);
      void refresh();
    } else {
      toast("error", `Couldn't kill ${proc.name}`, r?.message ?? "Unknown error");
    }
  };

  if (!snapshot) {
    return (
      <div className="memory-view">
        <div className="empty-view"><span>Loading process list...</span></div>
      </div>
    );
  }

  return (
    <div className="memory-view">
      {/* ── Summary strip ── */}
      <div className="memory-summary">
        <div className="memory-summary-main">
          <div className="memory-summary-big">
            <span className="memory-summary-value">{formatBytes(snapshot.usedBytes)}</span>
            <span className="memory-summary-denom">/ {formatBytes(snapshot.totalBytes)}</span>
          </div>
          <div className="memory-summary-bar">
            <div
              className={`memory-summary-bar-fill ${snapshot.usedPercent > 90 ? "high" : snapshot.usedPercent > 70 ? "mid" : "low"}`}
              style={{ width: `${snapshot.usedPercent}%` }}
            />
          </div>
          <div className="memory-summary-caption">
            {snapshot.usedPercent.toFixed(1)}% used · {formatBytes(snapshot.freeBytes)} free
          </div>
        </div>
        <MemoryStat label="Processes" value={formatCount(snapshot.processes.length)} />
        <MemoryStat label="CPU cores" value={String(snapshot.cpuCount)} />
        {snapshot.loadAvg !== null && (
          <MemoryStat label="Load 1m" value={snapshot.loadAvg.toFixed(2)} />
        )}
      </div>

      {/* ── Toolbar ── */}
      <div className="memory-toolbar">
        <input
          className="filter-input"
          value={filter}
          onInput={(e) => setFilter((e.target as HTMLInputElement).value)}
          placeholder="Filter by name or PID..."
        />
        <div className="memory-toolbar-spacer" />
        <button
          className={`chip ${paused ? "active" : ""}`}
          onClick={() => setPaused((v) => !v)}
          title={paused ? "Resume auto-refresh" : "Pause auto-refresh"}
        >
          {paused ? "Paused" : `Auto ${REFRESH_MS / 1000}s`}
        </button>
        <button className="chip" onClick={() => void refresh()} title="Refresh now">
          Refresh
        </button>
      </div>

      {/* ── Column headers ── */}
      <div className="memory-col-header">
        <SortHeader field="memory" label="Memory" current={sortField} dir={sortDir} onToggle={toggleSort} align="right" />
        <SortHeader field="cpu" label="CPU %" current={sortField} dir={sortDir} onToggle={toggleSort} align="right" />
        <SortHeader field="pid" label="PID" current={sortField} dir={sortDir} onToggle={toggleSort} align="right" />
        <SortHeader field="name" label="Name" current={sortField} dir={sortDir} onToggle={toggleSort} />
        <div />
      </div>

      {/* ── Process list ── */}
      <div className="memory-list-scroll">
        {visibleProcesses.length === 0 ? (
          <div className="empty-view">
            <span>{filter ? "No processes match the filter" : "No processes"}</span>
          </div>
        ) : (
          visibleProcesses.map((p) => {
            const memPct = snapshot.totalBytes > 0 ? (p.memoryBytes / snapshot.totalBytes) * 100 : 0;
            const isBusy = killingPid === p.pid;
            return (
              <div key={p.pid} className="memory-row" title={p.commandLine ?? p.name}>
                <div className="memory-row-mem">
                  <span className="memory-row-mem-value">{formatBytes(p.memoryBytes)}</span>
                  <div className="memory-row-mem-bar">
                    <div className="memory-row-mem-bar-fill" style={{ width: `${Math.min(memPct * 4, 100)}%` }} />
                  </div>
                </div>
                <div className="memory-row-cpu">
                  {p.cpuPercent !== null ? `${p.cpuPercent.toFixed(1)}%` : "—"}
                </div>
                <div className="memory-row-pid">{p.pid}</div>
                <div className="memory-row-name">
                  {p.name}
                  {!p.userOwned && <span className="memory-row-system-badge" title="System process">sys</span>}
                </div>
                <div className="memory-row-actions">
                  <button
                    className="action-btn warn"
                    disabled={isBusy}
                    onClick={() => void kill(p, false)}
                    title="Send a graceful shutdown signal"
                  >
                    End
                  </button>
                  <button
                    className="action-btn danger"
                    disabled={isBusy}
                    onClick={() => void kill(p, true)}
                    title="Force terminate (no cleanup)"
                  >
                    Kill
                  </button>
                </div>
              </div>
            );
          })
        )}
      </div>

      {snapshot.errorMessage && (
        <div className="memory-error">
          Error sampling processes: {snapshot.errorMessage}
        </div>
      )}
    </div>
  );
}

function MemoryStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="memory-stat">
      <span className="memory-stat-value">{value}</span>
      <span className="memory-stat-label">{label}</span>
    </div>
  );
}

function SortHeader({ field, label, current, dir, onToggle, align }: {
  field: SortField;
  label: string;
  current: SortField;
  dir: SortDir;
  onToggle: (f: SortField) => void;
  align?: "left" | "right";
}) {
  const isActive = current === field;
  return (
    <button
      className={`file-col-btn ${isActive ? "active" : ""}`}
      style={{ justifyContent: align === "right" ? "flex-end" : "flex-start" }}
      onClick={() => onToggle(field)}
    >
      {label}
      {isActive && (
        <svg width="8" height="8" viewBox="0 0 8 8" fill="currentColor" style={{ marginLeft: 3 }}>
          {dir === "desc" ? <path d="M4 6L1 2.5H7Z" /> : <path d="M4 2L1 5.5H7Z" />}
        </svg>
      )}
    </button>
  );
}
