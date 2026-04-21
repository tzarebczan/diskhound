import { useCallback, useEffect, useMemo, useRef, useState } from "preact/hooks";

import type { ProcessInfo, SystemMemorySnapshot } from "../../shared/contracts";
import { formatBytes, formatCount } from "../lib/format";
import { nativeApi } from "../nativeApi";
import {
  ProcessHeatmap,
  updateProcessHistory,
  type ProcessHistoryEntry,
} from "./ProcessHeatmap";
import { ProcessIcon } from "./ProcessIcon";
import { toast } from "./Toasts";

type SortField = "memory" | "cpu" | "name" | "pid";
type SortDir = "asc" | "desc";
type ViewMode = "list" | "treemap" | "heatmap";
/**
 * CPU percent display mode:
 * - "overall": each process shown as its share of 100% total system CPU.
 *   Matches Task Manager / Activity Monitor. An idle process on an
 *   otherwise-idle machine reads 0%.
 * - "active": each process shown as its share of the CURRENT CPU load.
 *   The active processes sum to ~100%. Great for "when my CPU is busy,
 *   WHO'S driving it?" regardless of whether that's 5% or 95% of the
 *   machine. Same 0% for idle processes, but non-idle ones get
 *   meaningful numbers even during light load.
 */
export type CpuScale = "overall" | "active";

const DEFAULT_REFRESH_MS = 5_000;
const MIN_REFRESH_MS = 2_000;
const MAX_REFRESH_MS = 30_000;
const VIEW_MODE_KEY = "diskhound:memory-view-mode";
const REFRESH_MS_KEY = "diskhound:memory-refresh-ms";
const CPU_SCALE_KEY = "diskhound:cpu-scale";

function getInitialCpuScale(): CpuScale {
  if (typeof window === "undefined") return "overall";
  const raw = window.localStorage.getItem(CPU_SCALE_KEY);
  // Accept legacy keys ("system" → "overall", "per-core" → "active") so
  // users who flipped the switch on a prior build keep their preference.
  if (raw === "active" || raw === "per-core") return "active";
  return "overall";
}

function getInitialViewMode(): ViewMode {
  if (typeof window === "undefined") return "list";
  const stored = window.localStorage.getItem(VIEW_MODE_KEY);
  if (stored === "treemap") return "treemap";
  if (stored === "heatmap") return "heatmap";
  return "list";
}

function getInitialRefreshMs(): number {
  if (typeof window === "undefined") return DEFAULT_REFRESH_MS;
  const raw = window.localStorage.getItem(REFRESH_MS_KEY);
  const parsed = raw ? parseInt(raw, 10) : DEFAULT_REFRESH_MS;
  if (!Number.isFinite(parsed)) return DEFAULT_REFRESH_MS;
  return Math.min(MAX_REFRESH_MS, Math.max(MIN_REFRESH_MS, parsed));
}

export function MemoryView() {
  const [snapshot, setSnapshot] = useState<SystemMemorySnapshot | null>(null);
  const [loadingPhase, setLoadingPhase] = useState<"initial" | "refreshing" | "idle">("initial");
  const [filter, setFilter] = useState("");
  const [sortField, setSortField] = useState<SortField>("memory");
  const [sortDir, setSortDir] = useState<SortDir>("desc");
  const [killingPid, setKillingPid] = useState<number | null>(null);
  const [paused, setPaused] = useState(false);
  const [viewMode, setViewMode] = useState<ViewMode>(getInitialViewMode);
  const [refreshMs, setRefreshMs] = useState<number>(getInitialRefreshMs);
  const [cpuScale, setCpuScale] = useState<CpuScale>(getInitialCpuScale);
  const [lastSampleMs, setLastSampleMs] = useState<number | null>(null);
  const timerRef = useRef<number | null>(null);

  // Shared context menu used by both ProcessTreemap and ProcessHeatmap —
  // lifted here so either view can open it, and a single Escape handler
  // dismisses either one.
  const [viewContextMenu, setViewContextMenu] = useState<{ x: number; y: number; process: ProcessInfo } | null>(null);
  const openViewContextMenu = useCallback((p: ProcessInfo, x: number, y: number) => {
    setViewContextMenu({ x, y, process: p });
  }, []);
  const closeViewContextMenu = useCallback(() => setViewContextMenu(null), []);

  useEffect(() => {
    if (!viewContextMenu) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setViewContextMenu(null);
    };
    const onClickAway = () => setViewContextMenu(null);
    window.addEventListener("keydown", onKey);
    window.addEventListener("click", onClickAway);
    window.addEventListener("contextmenu", onClickAway);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("click", onClickAway);
      window.removeEventListener("contextmenu", onClickAway);
    };
  }, [viewContextMenu]);

  // Rolling per-process CPU history used by the Heatmap view. Kept in a
  // ref at the MemoryView level so history survives switches between
  // List / Treemap / Heatmap tabs — if it lived inside ProcessHeatmap
  // it'd be reset every time the user clicked away and back.
  const historyRef = useRef<Map<number, ProcessHistoryEntry>>(new Map());
  const historyLastSampleRef = useRef({ value: 0 });
  // Parallel rolling record of "total per-core CPU activity at each
  // tick" — used by the Heatmap's Active mode to divide each process's
  // per-core sample by the total at that same tick. Capped to the same
  // HEATMAP_MAX_SAMPLES so indices stay aligned with per-process
  // entry.samples (same tick positions, same shift policy).
  const historyTotalsRef = useRef<number[]>([]);
  const [historyVersion, setHistoryVersion] = useState(0);
  const [samplesCollected, setSamplesCollected] = useState(0);

  useEffect(() => {
    try { window.localStorage.setItem(VIEW_MODE_KEY, viewMode); } catch { /* ignore */ }
  }, [viewMode]);
  useEffect(() => {
    try { window.localStorage.setItem(REFRESH_MS_KEY, String(refreshMs)); } catch { /* ignore */ }
  }, [refreshMs]);
  useEffect(() => {
    try { window.localStorage.setItem(CPU_SCALE_KEY, cpuScale); } catch { /* ignore */ }
  }, [cpuScale]);

  // Project the chosen CPU scale onto every process's cpuPercent so
  // downstream consumers (list, treemap, heatmap detail popover) don't
  // each need a scale-aware code path. The raw per-core value stays
  // available via cpuPercentPerCore for anyone who needs it.
  //
  // "overall" = pass-through (cpuPercent is already the 0-100 system-
  //   wide value set by the sampler).
  // "active"  = share of current CPU load. Each process's per-core
  //   value divided by the sum of all processes' per-core values,
  //   times 100. Non-zero processes sum to ~100% — so if your CPU is
  //   at 2% overall and Chrome is doing almost all of that, Chrome
  //   reads ~95% Active while showing only ~1.5% Overall.
  const scaledSnapshot = useMemo<SystemMemorySnapshot | null>(() => {
    if (!snapshot) return null;
    if (cpuScale === "overall") return snapshot;
    const totalPerCore = snapshot.processes.reduce(
      (sum, p) => sum + (p.cpuPercentPerCore ?? 0),
      0,
    );
    if (totalPerCore <= 0) {
      // Everything idle. Short-circuit so we don't blast zero-ratio
      // math over hundreds of processes.
      return snapshot;
    }
    return {
      ...snapshot,
      processes: snapshot.processes.map((p) => ({
        ...p,
        cpuPercent:
          p.cpuPercentPerCore !== null
            ? Math.min(100, (p.cpuPercentPerCore / totalPerCore) * 100)
            : p.cpuPercent,
      })),
    };
  }, [snapshot, cpuScale]);

  // One-time: pull the cached snapshot (instant paint) then kick off a
  // fresh sample in the background. Subsequent remounts of the tab will
  // find the cache warmed and render instantly.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const cached = await nativeApi.getCachedMemorySnapshot();
      if (!cancelled && cached) {
        setSnapshot(cached);
        setLoadingPhase("refreshing");
      }
      const fresh = await nativeApi.getMemorySnapshot();
      if (!cancelled) {
        setSnapshot(fresh);
        setLoadingPhase("idle");
        setLastSampleMs(fresh.sampleElapsedMs ?? null);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const refresh = useCallback(async () => {
    setLoadingPhase((prev) => (prev === "initial" ? "initial" : "refreshing"));
    const snap = await nativeApi.getMemorySnapshot();
    setSnapshot(snap);
    setLoadingPhase("idle");
    setLastSampleMs(snap.sampleElapsedMs ?? null);
  }, []);

  useEffect(() => {
    if (paused) return;
    timerRef.current = window.setInterval(() => void refresh(), refreshMs);
    return () => {
      if (timerRef.current !== null) window.clearInterval(timerRef.current);
    };
  }, [paused, refresh, refreshMs]);

  // Pause polling when tab/window hidden (saves CPU)
  useEffect(() => {
    const onVis = () => setPaused(document.hidden);
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, []);

  // Grow the heatmap's rolling CPU history every time a fresh sample
  // arrives. The cached snapshot on mount gets skipped (its isStale
  // flag is true) so we don't double-count anything.
  useEffect(() => {
    if (!snapshot || snapshot.isStale) return;
    const advanced = updateProcessHistory(historyRef.current, snapshot, historyLastSampleRef.current);
    if (advanced) {
      // Track the total per-core activity at THIS tick so Active mode
      // in the heatmap has a divisor for each historical column. Kept
      // in the same rolling-window shape as per-process samples.
      const totalPerCore = snapshot.processes.reduce(
        (sum, p) => sum + (p.cpuPercentPerCore ?? 0),
        0,
      );
      historyTotalsRef.current.push(totalPerCore);
      // The trim threshold matches ProcessHeatmap's HEATMAP_MAX_SAMPLES
      // (60). Intentionally hardcoded here to avoid an import cycle;
      // if the constant ever moves, update both places.
      if (historyTotalsRef.current.length > 60) {
        historyTotalsRef.current.shift();
      }
      setSamplesCollected((n) => Math.min(n + 1, 9999));
      setHistoryVersion((v) => v + 1);
    }
  }, [snapshot]);

  const toggleSort = (field: SortField) => {
    if (sortField === field) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortField(field);
      setSortDir(field === "name" ? "asc" : "desc");
    }
  };

  const visibleProcesses = useMemo(() => {
    if (!scaledSnapshot) return [];
    const q = filter.trim().toLowerCase();
    let list = q
      ? scaledSnapshot.processes.filter((p) =>
          p.name.toLowerCase().includes(q) || String(p.pid).includes(q),
        )
      : scaledSnapshot.processes;

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
  }, [scaledSnapshot, filter, sortField, sortDir]);

  const kill = async (proc: ProcessInfo, hard: boolean) => {
    const label = hard ? "Force kill" : "End";
    if (!confirm(`${label} ${proc.name} (PID ${proc.pid})?\n\nThis will terminate the process immediately.`)) return;
    setKillingPid(proc.pid);
    const r = await nativeApi.killProcess(proc.pid, hard ? "hard" : "soft");
    setKillingPid(null);
    if (r?.ok) {
      toast("success", `Terminated ${proc.name}`, `PID ${proc.pid}`);
      void refresh();
      return;
    }

    // Make the Windows "Access is denied" error actionable. taskkill emits
    // it whenever the target is system-owned or otherwise protected —
    // elevation is the only recourse, and most users don't know that
    // without being told.
    const msg = (r?.message ?? "").toLowerCase();
    const denied = msg.includes("access is denied") || msg.includes("access denied");
    if (denied) {
      toast(
        "error",
        `Needs admin privileges`,
        `${proc.name} is a protected process. Close DiskHound, right-click its shortcut, choose "Run as administrator", then try again.`,
      );
    } else {
      toast("error", `Couldn't kill ${proc.name}`, r?.message ?? "Unknown error");
    }
  };

  // First-paint: nothing in cache AND no fresh sample yet
  if (!snapshot) {
    return (
      <div className="memory-view">
        <div className="memory-initial-loading">
          <div className="memory-initial-spinner" />
          <div className="memory-initial-title">Sampling processes…</div>
          <div className="memory-initial-hint">
            This takes a second or two on the first run — we cache the result
            so the next visit is instant.
          </div>
        </div>
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

      {/* ── Toolbar + view-mode tabs ── */}
      <div className="memory-toolbar">
        <div className="memory-view-tabs" role="tablist">
          <button
            role="tab"
            aria-selected={viewMode === "list"}
            className={`memory-view-tab ${viewMode === "list" ? "active" : ""}`}
            onClick={() => setViewMode("list")}
            title="Tabular process list"
          >
            <svg width="13" height="13" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.3">
              <path d="M2 3.5H12M2 7H12M2 10.5H12" />
            </svg>
            List
          </button>
          <button
            role="tab"
            aria-selected={viewMode === "treemap"}
            className={`memory-view-tab ${viewMode === "treemap" ? "active" : ""}`}
            onClick={() => setViewMode("treemap")}
            title="Treemap — proportional area view"
          >
            <svg width="13" height="13" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.3">
              <rect x="1.5" y="1.5" width="7" height="7" />
              <rect x="9" y="1.5" width="3.5" height="4" />
              <rect x="9" y="6" width="3.5" height="6.5" />
              <rect x="1.5" y="9" width="7" height="3.5" />
            </svg>
            Treemap
          </button>
          <button
            role="tab"
            aria-selected={viewMode === "heatmap"}
            className={`memory-view-tab ${viewMode === "heatmap" ? "active" : ""}`}
            onClick={() => setViewMode("heatmap")}
            title="CPU heatmap — scrolling waterfall of CPU usage over time"
          >
            <svg width="13" height="13" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.3">
              <rect x="1.5" y="2" width="2" height="10" opacity="0.35" />
              <rect x="4" y="2" width="2" height="10" opacity="0.55" />
              <rect x="6.5" y="2" width="2" height="10" opacity="0.8" />
              <rect x="9" y="2" width="2" height="10" />
              <rect x="11.5" y="2" width="1" height="10" opacity="0.4" />
            </svg>
            CPU Heatmap
          </button>
        </div>
        <input
          className="filter-input"
          value={filter}
          onInput={(e) => setFilter((e.target as HTMLInputElement).value)}
          placeholder="Filter by name or PID..."
        />
        <div className="memory-toolbar-spacer" />
        {/* CPU scale toggle — only visible on views that actually show
         * CPU (list + heatmap). The treemap sorts by memory, so the
         * toggle would be confusing there. "Overall" matches Task
         * Manager; "Active" shows each process's share of the current
         * load so busy processes sum to ~100% regardless of total use. */}
        {viewMode !== "treemap" && (
          <div className="memory-cpu-scale-switch" role="tablist" aria-label="CPU scale">
            <button
              type="button"
              className={`memory-cpu-scale-btn ${cpuScale === "overall" ? "active" : ""}`}
              aria-pressed={cpuScale === "overall"}
              title="Overall — % of total system CPU. Idle machine ≈ 0% across the board. Matches Task Manager."
              onClick={() => setCpuScale("overall")}
            >
              Overall
            </button>
            <button
              type="button"
              className={`memory-cpu-scale-btn ${cpuScale === "active" ? "active" : ""}`}
              aria-pressed={cpuScale === "active"}
              title="Active — share of current CPU load. Busy processes sum to ~100% regardless of how much of the machine is in use."
              onClick={() => setCpuScale("active")}
            >
              Active
            </button>
          </div>
        )}
        {loadingPhase === "refreshing" && (
          <span className="memory-refresh-indicator" title="Refreshing…">
            <span className="memory-refresh-dot" />
            refreshing
          </span>
        )}
        <RefreshIntervalChip value={refreshMs} paused={paused} onChange={setRefreshMs} onTogglePause={() => setPaused((v) => !v)} />
        <button
          className="chip"
          onClick={() => void refresh()}
          disabled={loadingPhase === "refreshing"}
          title={lastSampleMs !== null ? `Last sample took ${lastSampleMs}ms` : "Refresh now"}
        >
          Refresh
        </button>
      </div>

      {/* ── Main body: switch by mode ── */}
      {viewMode === "list" && (
        <ProcessList
          processes={visibleProcesses}
          total={snapshot.processes.length}
          totalBytes={snapshot.totalBytes}
          filter={filter}
          sortField={sortField}
          sortDir={sortDir}
          onToggleSort={toggleSort}
          killingPid={killingPid}
          onKill={kill}
        />
      )}
      {viewMode === "treemap" && (
        <ProcessTreemap
          processes={visibleProcesses}
          totalBytes={snapshot.totalBytes}
          onKill={kill}
        />
      )}
      {viewMode === "heatmap" && (
        <ProcessHeatmap
          key={historyVersion}
          history={historyRef.current}
          historyTotals={historyTotalsRef.current}
          sampleCount={samplesCollected}
          filter={filter}
          cpuScale={cpuScale}
          cpuCount={snapshot.cpuCount}
          onKill={kill}
          onOpenContextMenu={openViewContextMenu}
        />
      )}

      {/* Shared context menu — heatmap opens it via callback; rendered at
       * the MemoryView level so a single Esc/click-away handler dismisses
       * regardless of which view was hot when it opened. */}
      {viewContextMenu && (
        <ProcessContextMenu
          x={viewContextMenu.x}
          y={viewContextMenu.y}
          proc={viewContextMenu.process}
          onClose={closeViewContextMenu}
          onKill={kill}
        />
      )}

      {snapshot.errorMessage && (
        <div className="memory-error">
          Error sampling processes: {snapshot.errorMessage}
        </div>
      )}
    </div>
  );
}

// ── List view ──────────────────────────────────────────────────────────────

/** A grouped row in the list view — either a multi-instance process family
 *  (rendered as a collapsible parent) or a single instance. */
interface ProcessGroup {
  name: string;
  processes: ProcessInfo[];
  totalMemory: number;
  totalCpu: number; // null cpuPercent treated as 0
  exePath: string | null;
  isSystem: boolean;
}

function buildGroups(processes: ProcessInfo[], sortField: SortField, sortDir: SortDir): ProcessGroup[] {
  const byName = new Map<string, ProcessInfo[]>();
  for (const p of processes) {
    const existing = byName.get(p.name);
    if (existing) existing.push(p);
    else byName.set(p.name, [p]);
  }

  const groups: ProcessGroup[] = [];
  for (const [name, procs] of byName) {
    const totalMemory = procs.reduce((s, p) => s + p.memoryBytes, 0);
    const totalCpu = procs.reduce((s, p) => s + (p.cpuPercent ?? 0), 0);
    const exePath = procs.find((p) => p.exePath)?.exePath ?? null;
    const isSystem = procs.every((p) => !p.userOwned);
    groups.push({ name, processes: procs, totalMemory, totalCpu, exePath, isSystem });
  }

  // Sort group-level by the chosen field (using totals).
  const m = sortDir === "asc" ? 1 : -1;
  groups.sort((a, b) => {
    switch (sortField) {
      case "memory": return (a.totalMemory - b.totalMemory) * m;
      case "cpu":    return (a.totalCpu - b.totalCpu) * m;
      case "name":   return a.name.localeCompare(b.name) * m;
      case "pid":    return (a.processes[0]!.pid - b.processes[0]!.pid) * m;
    }
  });

  // Sort children within each group by memory (always desc), so the heaviest
  // child surfaces first when expanded.
  for (const g of groups) {
    g.processes.sort((a, b) => b.memoryBytes - a.memoryBytes);
  }

  return groups;
}

function ProcessList(props: {
  processes: ProcessInfo[];
  total: number;
  totalBytes: number;
  filter: string;
  sortField: SortField;
  sortDir: SortDir;
  onToggleSort: (f: SortField) => void;
  killingPid: number | null;
  onKill: (p: ProcessInfo, hard: boolean) => void;
}) {
  const { processes, total, totalBytes, filter, sortField, sortDir, onToggleSort, killingPid, onKill } = props;
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const groups = useMemo(
    () => buildGroups(processes, sortField, sortDir),
    [processes, sortField, sortDir],
  );

  // Max memory across single rows AND group totals — keeps bars proportional
  // even when groups dominate.
  const maxMem = useMemo(
    () => groups.reduce((max, g) => Math.max(max, g.totalMemory), 0),
    [groups],
  );

  const toggleGroup = (name: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  };

  return (
    <>
      <div className="memory-col-header">
        <div className="memory-row-icon-hdr" />
        <SortHeader field="memory" label="Memory" current={sortField} dir={sortDir} onToggle={onToggleSort} align="right" />
        <SortHeader field="cpu" label="CPU %" current={sortField} dir={sortDir} onToggle={onToggleSort} align="right" />
        <SortHeader field="pid" label="PID" current={sortField} dir={sortDir} onToggle={onToggleSort} align="right" />
        <SortHeader field="name" label="Name" current={sortField} dir={sortDir} onToggle={onToggleSort} />
        <div />
      </div>
      <div className="memory-list-scroll">
        {groups.length === 0 ? (
          <div className="empty-view">
            <span>{filter ? "No processes match the filter" : `No processes visible (of ${total})`}</span>
          </div>
        ) : (
          groups.map((g) => {
            if (g.processes.length === 1) {
              const p = g.processes[0]!;
              return (
                <ProcessRow
                  key={`solo-${p.pid}`}
                  proc={p}
                  maxMem={maxMem}
                  totalBytes={totalBytes}
                  isBusy={killingPid === p.pid}
                  onKill={onKill}
                />
              );
            }
            return (
              <ProcessGroupRows
                key={`group-${g.name}`}
                group={g}
                maxMem={maxMem}
                totalBytes={totalBytes}
                isExpanded={expanded.has(g.name)}
                onToggle={() => toggleGroup(g.name)}
                killingPid={killingPid}
                onKill={onKill}
              />
            );
          })
        )}
      </div>
    </>
  );
}

function ProcessGroupRows(props: {
  group: ProcessGroup;
  maxMem: number;
  totalBytes: number;
  isExpanded: boolean;
  onToggle: () => void;
  killingPid: number | null;
  onKill: (p: ProcessInfo, hard: boolean) => void;
}) {
  const { group, maxMem, totalBytes, isExpanded, onToggle, killingPid, onKill } = props;
  const memPct = maxMem > 0 ? (group.totalMemory / maxMem) * 100 : 0;
  const totalPct = totalBytes > 0 ? (group.totalMemory / totalBytes) * 100 : 0;
  const memClass = totalPct > 5 ? "high" : totalPct > 1 ? "mid" : "low";
  const cpuPct = Math.min(100, group.totalCpu);
  const cpuClass = cpuPct > 50 ? "high" : cpuPct > 15 ? "mid" : "low";

  return (
    <>
      <div
        className={`memory-row memory-row-group ${isExpanded ? "expanded" : ""}`}
        onClick={onToggle}
        title={`${group.processes.length} instances · click to ${isExpanded ? "collapse" : "expand"}`}
      >
        <div className="memory-row-icon memory-row-chevron">
          <svg
            width="10" height="10" viewBox="0 0 10 10"
            fill="none" stroke="currentColor" strokeWidth="1.5"
            style={{ transform: isExpanded ? "rotate(90deg)" : "rotate(0deg)", transition: "transform 0.12s" }}
          >
            <path d="M3 2L7 5L3 8" />
          </svg>
        </div>
        <div className="memory-row-mem">
          <span className={`memory-row-mem-value ${memClass}`}>{formatBytes(group.totalMemory)}</span>
          <div className="memory-row-mem-bar">
            <div className={`memory-row-mem-bar-fill ${memClass}`} style={{ width: `${memPct}%` }} />
          </div>
        </div>
        <div className="memory-row-cpu">
          <span className={`memory-row-cpu-value ${cpuClass}`}>{group.totalCpu.toFixed(1)}%</span>
          <div className="memory-row-cpu-bar">
            <div className={`memory-row-cpu-bar-fill ${cpuClass}`} style={{ width: `${cpuPct}%` }} />
          </div>
        </div>
        <div className="memory-row-pid memory-row-count">&times;{group.processes.length}</div>
        <div className="memory-row-name memory-row-name-group">
          <ProcessIcon exePath={group.exePath} className="memory-row-icon-img memory-row-icon-inline" />
          {group.name}
          {group.isSystem && <span className="memory-row-system-badge" title="System processes">sys</span>}
        </div>
        <div className="memory-row-actions" />
      </div>
      {isExpanded && group.processes.map((p) => (
        <ProcessRow
          key={p.pid}
          proc={p}
          maxMem={maxMem}
          totalBytes={totalBytes}
          isBusy={killingPid === p.pid}
          onKill={onKill}
          isChild
        />
      ))}
    </>
  );
}

function ProcessRow(props: {
  proc: ProcessInfo;
  maxMem: number;
  totalBytes: number;
  isBusy: boolean;
  onKill: (p: ProcessInfo, hard: boolean) => void;
  isChild?: boolean;
}) {
  const { proc, maxMem, totalBytes, isBusy, onKill, isChild } = props;
  const memPct = maxMem > 0 ? (proc.memoryBytes / maxMem) * 100 : 0;
  const totalPct = totalBytes > 0 ? (proc.memoryBytes / totalBytes) * 100 : 0;
  const memClass = totalPct > 5 ? "high" : totalPct > 1 ? "mid" : "low";
  const cpuRaw = proc.cpuPercent ?? 0;
  const cpuPct = Math.min(100, cpuRaw);
  const cpuClass = cpuPct > 50 ? "high" : cpuPct > 15 ? "mid" : "low";

  return (
    <div
      className={`memory-row ${isChild ? "memory-row-child" : ""}`}
      title={proc.commandLine ?? proc.exePath ?? proc.name}
    >
      <div className="memory-row-icon">
        <ProcessIcon exePath={proc.exePath} className="memory-row-icon-img" />
      </div>
      <div className="memory-row-mem">
        <span className={`memory-row-mem-value ${memClass}`}>{formatBytes(proc.memoryBytes)}</span>
        <div className="memory-row-mem-bar">
          <div className={`memory-row-mem-bar-fill ${memClass}`} style={{ width: `${memPct}%` }} />
        </div>
      </div>
      <div className="memory-row-cpu">
        <span className={`memory-row-cpu-value ${cpuClass}`}>
          {proc.cpuPercent !== null ? `${cpuRaw.toFixed(1)}%` : "—"}
        </span>
        {proc.cpuPercent !== null && (
          <div className="memory-row-cpu-bar">
            <div className={`memory-row-cpu-bar-fill ${cpuClass}`} style={{ width: `${cpuPct}%` }} />
          </div>
        )}
      </div>
      <div className="memory-row-pid">{proc.pid}</div>
      <div className="memory-row-name">
        {isChild && <span className="memory-row-child-prefix">{"\u2514"}</span>}
        {proc.name}
        {!proc.userOwned && <span className="memory-row-system-badge" title="System process">sys</span>}
      </div>
      <div className="memory-row-actions">
        <button className="action-btn warn" disabled={isBusy} onClick={() => onKill(proc, false)} title="Graceful shutdown (SIGTERM/taskkill)">End</button>
        <button className="action-btn danger" disabled={isBusy} onClick={() => onKill(proc, true)} title="Force terminate (SIGKILL/taskkill /F)">Kill</button>
      </div>
    </div>
  );
}

// ── Treemap view ───────────────────────────────────────────────────────────

/** Consistent color per process family — hashed from the name so repeat
 *  processes (e.g. all chrome.exe instances) group visually when we don't
 *  have an icon-derived color to use. */
const COLOR_PALETTE = [
  "#3b82f6", "#10b981", "#f59e0b", "#ef4444", "#8b5cf6",
  "#ec4899", "#06b6d4", "#84cc16", "#f97316", "#6366f1",
  "#14b8a6", "#a855f7", "#eab308", "#22c55e", "#0ea5e9",
];

function colorForProcessName(name: string): string {
  let h = 0;
  for (let i = 0; i < name.length; i++) {
    h = ((h << 5) - h + name.charCodeAt(i)) | 0;
  }
  return COLOR_PALETTE[Math.abs(h) % COLOR_PALETTE.length];
}

/**
 * Strip `.exe` from a process name for display. Other extensions (`.bat`,
 * `.ps1`, `.py`) stay — they carry genuine information about what kind
 * of process this is. `.exe` is noise on Windows where nearly every
 * process carries it.
 */
function prettyProcessName(name: string): string {
  if (/\.exe$/i.test(name)) return name.slice(0, -4);
  return name;
}

// ── Process appearance cache (icon + dominant color) ─────────────────────
//
// Loading icons + extracting a dominant color is async (IPC → image decode
// → pixel sample) but the canvas draw loop is synchronous. We keep a
// module-scoped cache so:
//   - Results persist across MemoryView remounts (tab switches)
//   - Every process sharing an exePath reuses the same icon + color
//   - A simple version counter lets the treemap subscribe + redraw when
//     new icons resolve, without each rect having its own useState.
//
// Cache state per exePath:
//   - undefined        → never seen, safe to kick off a load
//   - null (image)     → load in flight or failed; fallback color applies
//   - HTMLImageElement → icon ready to draw
//
// Colors default to the hash-based palette and upgrade to icon-derived
// once pixel sampling completes.

interface ProcessAppearance {
  icon: HTMLImageElement | null;
  color: string;
}

const appearanceCache = new Map<string, ProcessAppearance>();
const appearanceInFlight = new Set<string>();
let appearanceVersion = 0;
const appearanceSubscribers = new Set<() => void>();

function notifyAppearanceSubscribers(): void {
  appearanceVersion++;
  for (const fn of appearanceSubscribers) fn();
}

/**
 * Derive a dominant color from a fully-decoded icon. Renders the icon
 * at 16x16, walks opaque pixels, and averages them with extra weight on
 * saturated pixels so a brightly-colored logo wins over a field of grey
 * chrome. Returns null if the icon had no opaque pixels.
 */
function extractDominantColor(img: HTMLImageElement): string | null {
  try {
    const canvas = document.createElement("canvas");
    canvas.width = 16;
    canvas.height = 16;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    ctx.drawImage(img, 0, 0, 16, 16);
    const data = ctx.getImageData(0, 0, 16, 16).data;
    let r = 0, g = 0, b = 0, totalWeight = 0;
    for (let i = 0; i < data.length; i += 4) {
      const alpha = data[i + 3];
      if (alpha < 128) continue;
      const rr = data[i]!, gg = data[i + 1]!, bb = data[i + 2]!;
      const maxC = Math.max(rr, gg, bb);
      const minC = Math.min(rr, gg, bb);
      const saturation = maxC === 0 ? 0 : (maxC - minC) / maxC;
      // Favor saturated pixels so tinted chrome doesn't swamp a brand accent.
      const weight = 1 + saturation * 3;
      r += rr * weight;
      g += gg * weight;
      b += bb * weight;
      totalWeight += weight;
    }
    if (totalWeight === 0) return null;
    // Darken slightly so light-icon processes (mostly-white icons) still
    // read as distinct squares against the dark theme background.
    const avgR = Math.round((r / totalWeight) * 0.85);
    const avgG = Math.round((g / totalWeight) * 0.85);
    const avgB = Math.round((b / totalWeight) * 0.85);
    return `rgb(${avgR}, ${avgG}, ${avgB})`;
  } catch {
    return null;
  }
}

function loadProcessAppearance(exePath: string, fallbackColor: string): void {
  if (appearanceCache.has(exePath) || appearanceInFlight.has(exePath)) return;
  appearanceInFlight.add(exePath);
  void nativeApi.getExecutableIcon(exePath, "normal").then((url) => {
    if (!url) {
      appearanceCache.set(exePath, { icon: null, color: fallbackColor });
      appearanceInFlight.delete(exePath);
      notifyAppearanceSubscribers();
      return;
    }
    const img = new Image();
    img.src = url;
    img.decode().then(() => {
      const dominant = extractDominantColor(img);
      appearanceCache.set(exePath, { icon: img, color: dominant ?? fallbackColor });
      appearanceInFlight.delete(exePath);
      notifyAppearanceSubscribers();
    }).catch(() => {
      appearanceCache.set(exePath, { icon: null, color: fallbackColor });
      appearanceInFlight.delete(exePath);
      notifyAppearanceSubscribers();
    });
  }).catch(() => {
    appearanceCache.set(exePath, { icon: null, color: fallbackColor });
    appearanceInFlight.delete(exePath);
    notifyAppearanceSubscribers();
  });
}

function getAppearance(proc: ProcessInfo): ProcessAppearance {
  const fallback = { icon: null, color: colorForProcessName(proc.name) };
  if (!proc.exePath) return fallback;
  return appearanceCache.get(proc.exePath) ?? fallback;
}

interface TreemapRect {
  x: number;
  y: number;
  w: number;
  h: number;
  process: ProcessInfo;
  color: string;
}

interface WeightedProcess {
  process: ProcessInfo;
  weight: number;
}

function squarifyProcesses(items: WeightedProcess[], bounds: { x: number; y: number; w: number; h: number }, totalWeight: number, out: TreemapRect[]): void {
  if (items.length === 0 || bounds.w <= 0 || bounds.h <= 0) return;

  if (items.length === 1) {
    out.push({
      ...bounds,
      process: items[0]!.process,
      color: colorForProcessName(items[0]!.process.name),
    });
    return;
  }

  const isWide = bounds.w >= bounds.h;
  const sideLen = isWide ? bounds.h : bounds.w;
  const totalArea = bounds.w * bounds.h;

  let rowItems: WeightedProcess[] = [];
  let rowWeight = 0;
  let bestAspect = Infinity;
  let splitIndex = 0;

  for (let i = 0; i < items.length; i++) {
    const item = items[i]!;
    const nextItems = [...rowItems, item];
    const nextRowWeight = rowWeight + item.weight;
    const nextRowLen = (nextRowWeight / totalWeight) * (isWide ? bounds.w : bounds.h);

    let worstAspect = 0;
    for (const ri of nextItems) {
      const itemLen = sideLen > 0 && nextRowLen > 0
        ? (ri.weight / totalWeight) * totalArea / nextRowLen
        : 1;
      const aspect = Math.max(nextRowLen / itemLen, itemLen / nextRowLen);
      worstAspect = Math.max(worstAspect, aspect);
    }

    if (worstAspect <= bestAspect || rowItems.length === 0) {
      bestAspect = worstAspect;
      rowItems = nextItems;
      rowWeight = nextRowWeight;
      splitIndex = i + 1;
    } else {
      break;
    }
  }

  // Lay out the row, then recurse on remaining items + remaining bounds.
  const rowLen = (rowWeight / totalWeight) * (isWide ? bounds.w : bounds.h);
  let cursor = 0;
  for (const ri of rowItems) {
    const itemLen = rowLen > 0
      ? (ri.weight / rowWeight) * sideLen
      : 0;
    if (isWide) {
      out.push({
        x: bounds.x,
        y: bounds.y + cursor,
        w: rowLen,
        h: itemLen,
        process: ri.process,
        color: colorForProcessName(ri.process.name),
      });
    } else {
      out.push({
        x: bounds.x + cursor,
        y: bounds.y,
        w: itemLen,
        h: rowLen,
        process: ri.process,
        color: colorForProcessName(ri.process.name),
      });
    }
    cursor += itemLen;
  }

  const nextBounds = isWide
    ? { x: bounds.x + rowLen, y: bounds.y, w: bounds.w - rowLen, h: bounds.h }
    : { x: bounds.x, y: bounds.y + rowLen, w: bounds.w, h: bounds.h - rowLen };

  squarifyProcesses(items.slice(splitIndex), nextBounds, totalWeight - rowWeight, out);
}

function ProcessTreemap(props: {
  processes: ProcessInfo[];
  totalBytes: number;
  onKill: (p: ProcessInfo, hard: boolean) => void;
}) {
  const { processes, onKill } = props;
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rectsRef = useRef<TreemapRect[]>([]);
  const [dims, setDims] = useState({ w: 0, h: 0 });
  const [hover, setHover] = useState<{ x: number; y: number; process: ProcessInfo } | null>(null);
  const [selected, setSelected] = useState<ProcessInfo | null>(null);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; process: ProcessInfo } | null>(null);
  // Bumped whenever a new process icon / dominant color finishes loading
  // in the module cache. Treated as a render dependency so the canvas
  // repaints once icons arrive.
  const [, setAppearanceTick] = useState(0);
  useEffect(() => {
    const fn = () => setAppearanceTick((t) => t + 1);
    appearanceSubscribers.add(fn);
    return () => { appearanceSubscribers.delete(fn); };
  }, []);
  // Kick off appearance loads for any process we haven't seen yet.
  // Bounded work per render: at most one load per unique exePath.
  useEffect(() => {
    for (const p of processes) {
      if (!p.exePath) continue;
      loadProcessAppearance(p.exePath, colorForProcessName(p.name));
    }
  }, [processes]);

  // Escape closes any open popover/menu. Centralised here so users can hit
  // Esc whether they opened the detail via left-click or the compact menu
  // via right-click — both dismiss cleanly without needing to reach for
  // the close button.
  useEffect(() => {
    if (!selected && !contextMenu) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setSelected(null);
        setContextMenu(null);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selected, contextMenu]);

  // Close context menu on any click outside of it (the menu itself stops
  // propagation so this doesn't accidentally fire on its own buttons).
  useEffect(() => {
    if (!contextMenu) return;
    const close = () => setContextMenu(null);
    window.addEventListener("click", close);
    window.addEventListener("contextmenu", close);
    return () => {
      window.removeEventListener("click", close);
      window.removeEventListener("contextmenu", close);
    };
  }, [contextMenu]);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      const { width, height } = entry.contentRect;
      setDims({ w: Math.floor(width), h: Math.floor(height) });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || dims.w === 0 || dims.h === 0) return;

    const dpr = typeof window !== "undefined" ? Math.min(window.devicePixelRatio || 1, 2) : 1;
    canvas.width = dims.w * dpr;
    canvas.height = dims.h * dpr;
    canvas.style.width = `${dims.w}px`;
    canvas.style.height = `${dims.h}px`;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, dims.w, dims.h);

    // Weight using sqrt for visual balance (same trick as the disk treemap
    // — very large processes don't swallow the whole canvas).
    const sorted = [...processes].sort((a, b) => b.memoryBytes - a.memoryBytes);
    const weighted = sorted
      .filter((p) => p.memoryBytes > 0)
      .map((p) => ({ process: p, weight: Math.sqrt(p.memoryBytes) }));
    const totalWeight = weighted.reduce((s, i) => s + i.weight, 0);
    if (totalWeight === 0) {
      rectsRef.current = [];
      return;
    }

    const rects: TreemapRect[] = [];
    squarifyProcesses(weighted, { x: 0, y: 0, w: dims.w, h: dims.h }, totalWeight, rects);
    rectsRef.current = rects;

    for (const r of rects) {
      if (r.w < 1 || r.h < 1) continue;
      // Appearance-aware fill: icon-derived color when we have one,
      // hash-based palette until the icon finishes loading.
      const appearance = getAppearance(r.process);
      ctx.fillStyle = appearance.color;
      ctx.fillRect(r.x, r.y, r.w, r.h);

      // Cushion shading (same vibe as disk treemap)
      if (r.w >= 6 && r.h >= 6) {
        const radius = Math.max(r.w, r.h) * 0.9;
        const grad = ctx.createRadialGradient(
          r.x + r.w * 0.25, r.y + r.h * 0.2, 0,
          r.x + r.w * 0.25, r.y + r.h * 0.2, radius,
        );
        grad.addColorStop(0, "rgba(255,255,255,0.28)");
        grad.addColorStop(0.5, "rgba(255,255,255,0.04)");
        grad.addColorStop(1, "rgba(0,0,0,0.30)");
        ctx.fillStyle = grad;
        ctx.fillRect(r.x, r.y, r.w, r.h);
      }

      const pad = 4;
      // Draw the app icon in the top-left when the rect is large enough
      // to hold one without crowding the label. Icon size scales with
      // rect size but is capped so it doesn't swamp a very tall tile.
      let labelX = r.x + pad;
      const labelY = r.y + pad;
      if (appearance.icon && r.w >= 60 && r.h >= 36) {
        const iconSize = Math.min(28, Math.max(14, Math.floor(Math.min(r.w, r.h) * 0.22)));
        ctx.save();
        ctx.shadowColor = "rgba(0,0,0,0.55)";
        ctx.shadowBlur = 3;
        ctx.shadowOffsetY = 1;
        try {
          ctx.drawImage(appearance.icon, r.x + pad, r.y + pad, iconSize, iconSize);
        } catch {
          // Drawing an undecoded image can throw; the appearance
          // subscriber drives a redraw once it's ready.
        }
        ctx.restore();
        labelX = r.x + pad + iconSize + 6;
      }

      const maxLabelW = r.w - (labelX - r.x) - pad;
      if (r.w > 44 && r.h > 20 && maxLabelW > 24) {
        const fontSize = Math.min(12, Math.max(8, Math.min(r.w / 10, r.h / 3)));
        ctx.font = `500 ${fontSize}px "JetBrains Mono", monospace`;
        ctx.textBaseline = "top";

        // Strip `.exe` on display — noise on Windows where nearly every
        // process carries it. Other extensions (.bat, .ps1, .py) stay.
        let label = prettyProcessName(r.process.name);
        let measured = ctx.measureText(label).width;
        if (measured > maxLabelW) {
          const charW = measured / label.length;
          const maxChars = Math.floor(maxLabelW / charW) - 1;
          label = maxChars > 2 ? label.slice(0, maxChars) + "…" : "";
        }
        if (label) {
          ctx.fillStyle = "rgba(0,0,0,0.5)";
          ctx.fillText(label, labelX + 1, labelY + 1, maxLabelW);
          ctx.fillStyle = "rgba(255,255,255,0.95)";
          ctx.fillText(label, labelX, labelY, maxLabelW);
        }

        if (r.h > fontSize + pad * 2 + 10) {
          const sizeFont = Math.min(10, Math.max(7, fontSize - 2));
          ctx.font = `400 ${sizeFont}px "JetBrains Mono", monospace`;
          const sizeLabel = formatBytes(r.process.memoryBytes);
          ctx.fillStyle = "rgba(0,0,0,0.4)";
          ctx.fillText(sizeLabel, labelX + 1, labelY + fontSize + 2 + 1, maxLabelW);
          ctx.fillStyle = "rgba(255,255,255,0.75)";
          ctx.fillText(sizeLabel, labelX, labelY + fontSize + 2, maxLabelW);
        }
      }
    }
    // Keep the appearance subscriber as a live render dependency.
    void appearanceVersion;
  }, [processes, dims]);

  const hitTest = useCallback((e: MouseEvent): ProcessInfo | null => {
    const canvas = canvasRef.current;
    if (!canvas) return null;
    const rect = canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    const hit = rectsRef.current.find(
      (r) => mx >= r.x && mx <= r.x + r.w && my >= r.y && my <= r.y + r.h,
    );
    return hit?.process ?? null;
  }, []);

  const handleMouseMove = useCallback((e: MouseEvent) => {
    const proc = hitTest(e);
    if (proc) {
      const tx = Math.min(e.clientX + 14, window.innerWidth - 260);
      const ty = Math.min(e.clientY + 14, window.innerHeight - 100);
      setHover({ x: tx, y: ty, process: proc });
    } else {
      setHover(null);
    }
  }, [hitTest]);

  const handleClick = useCallback((e: MouseEvent) => {
    const proc = hitTest(e);
    if (proc) setSelected(proc);
  }, [hitTest]);

  const handleContextMenu = useCallback((e: MouseEvent) => {
    const proc = hitTest(e);
    if (!proc) return;
    e.preventDefault();
    e.stopPropagation();
    setHover(null);
    setSelected(null);
    setContextMenu({ x: e.clientX, y: e.clientY, process: proc });
  }, [hitTest]);

  if (processes.length === 0) {
    return (
      <div className="memory-treemap-container" ref={containerRef}>
        <div className="treemap-empty">
          <div className="treemap-empty-icon">&#x25A6;</div>
          <div>No processes to visualize</div>
        </div>
      </div>
    );
  }

  return (
    <div className="memory-treemap-container" ref={containerRef}>
      <canvas
        ref={canvasRef}
        onMouseMove={handleMouseMove}
        onMouseLeave={() => setHover(null)}
        onClick={handleClick}
        onContextMenu={handleContextMenu}
        style={{ cursor: hover ? "pointer" : "default" }}
      />
      {hover && !selected && !contextMenu && (
        <div className="treemap-tooltip" style={{ left: hover.x, top: hover.y }}>
          <span className="treemap-tooltip-size">{formatBytes(hover.process.memoryBytes)}</span>
          <span className="treemap-tooltip-name">{hover.process.name}</span>
          <div className="treemap-tooltip-path">
            PID {hover.process.pid}
            {hover.process.cpuPercent !== null ? ` · ${hover.process.cpuPercent.toFixed(1)}% CPU` : ""}
          </div>
          {hover.process.exePath && (
            <div className="treemap-tooltip-meta">{hover.process.exePath}</div>
          )}
        </div>
      )}
      {selected && (
        <ProcessDetailPopover
          proc={selected}
          onClose={() => setSelected(null)}
          onKill={onKill}
        />
      )}
      {contextMenu && (
        <ProcessContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          proc={contextMenu.process}
          onClose={() => setContextMenu(null)}
          onKill={onKill}
        />
      )}
    </div>
  );
}

/**
 * Compact right-click menu on the treemap. Intentionally smaller and
 * faster-to-use than the full ProcessDetailPopover — one rightclick +
 * enter-key on the item you want lets you kill a process in two gestures.
 * Positions itself to stay inside the viewport.
 */
function ProcessContextMenu(props: {
  x: number;
  y: number;
  proc: ProcessInfo;
  onClose: () => void;
  onKill: (p: ProcessInfo, hard: boolean) => void;
}) {
  const { x, y, proc, onClose, onKill } = props;
  const menuRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x, y });

  useEffect(() => {
    const el = menuRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const nx = x + rect.width > window.innerWidth ? x - rect.width : x;
    const ny = y + rect.height > window.innerHeight ? y - rect.height : y;
    setPos({ x: Math.max(4, nx), y: Math.max(4, ny) });
  }, [x, y]);

  const act = (fn: () => void) => {
    onClose();
    fn();
  };

  return (
    <div
      ref={menuRef}
      className="process-ctx-menu"
      style={{ left: pos.x, top: pos.y }}
      onClick={(e) => e.stopPropagation()}
      onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); }}
      role="menu"
    >
      <div className="process-ctx-header">
        <div className="process-ctx-name">{proc.name}</div>
        <div className="process-ctx-meta">
          PID {proc.pid} · {formatBytes(proc.memoryBytes)}
          {proc.cpuPercent !== null && ` · ${proc.cpuPercent.toFixed(1)}% CPU`}
        </div>
      </div>
      {proc.exePath && (
        <>
          <button
            className="process-ctx-item"
            role="menuitem"
            onClick={() => act(() => void nativeApi.revealPath(proc.exePath!))}
          >
            <svg width="12" height="12" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.3">
              <path d="M1.5 3.5V11.5C1.5 12.05 1.95 12.5 2.5 12.5H11.5C12.05 12.5 12.5 12.05 12.5 11.5V5.5C12.5 4.95 12.05 4.5 11.5 4.5H7L5.5 2.5H2.5C1.95 2.5 1.5 2.95 1.5 3.5Z" />
            </svg>
            Reveal executable
          </button>
          <button
            className="process-ctx-item"
            role="menuitem"
            onClick={() =>
              act(() => {
                void navigator.clipboard.writeText(proc.exePath!).then(
                  () => toast("success", "Path copied", proc.exePath!),
                  () => toast("error", "Couldn't copy path"),
                );
              })
            }
          >
            <svg width="12" height="12" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.3">
              <rect x="4" y="4" width="8" height="9" rx="1" />
              <path d="M4 4V3C4 2.45 4.45 2 5 2H9C9.55 2 10 2.45 10 3V4" />
            </svg>
            Copy path
          </button>
          <div className="process-ctx-divider" />
        </>
      )}
      <button
        className="process-ctx-item process-ctx-warn"
        role="menuitem"
        onClick={() => act(() => onKill(proc, false))}
      >
        <svg width="12" height="12" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.3">
          <circle cx="7" cy="7" r="5.5" />
          <path d="M7 4V7.5" />
        </svg>
        End (graceful)
      </button>
      <button
        className="process-ctx-item process-ctx-danger"
        role="menuitem"
        onClick={() => act(() => onKill(proc, true))}
      >
        <svg width="12" height="12" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.3">
          <path d="M3.5 3.5L10.5 10.5M10.5 3.5L3.5 10.5" />
        </svg>
        Force kill
      </button>
    </div>
  );
}

function ProcessDetailPopover(props: {
  proc: ProcessInfo;
  onClose: () => void;
  onKill: (p: ProcessInfo, hard: boolean) => void;
}) {
  const { proc, onClose, onKill } = props;
  return (
    <div className="process-detail-overlay" onClick={onClose}>
      <div className="process-detail-card" onClick={(e) => e.stopPropagation()}>
        <div className="process-detail-head">
          <ProcessIcon exePath={proc.exePath} className="process-detail-icon" />
          <div className="process-detail-info">
            <div className="process-detail-name">{proc.name}</div>
            <div className="process-detail-pid">PID {proc.pid}</div>
          </div>
          <button className="process-detail-close" onClick={onClose} aria-label="Close">&times;</button>
        </div>
        <div className="process-detail-stats">
          <DetailStat label="Memory" value={formatBytes(proc.memoryBytes)} />
          <DetailStat label="CPU" value={proc.cpuPercent !== null ? `${proc.cpuPercent.toFixed(1)}%` : "—"} />
          <DetailStat label="Kind" value={proc.userOwned ? "User" : "System"} />
        </div>
        {proc.exePath && (
          <div className="process-detail-path">{proc.exePath}</div>
        )}
        <div className="process-detail-actions">
          <button className="action-btn warn" onClick={() => onKill(proc, false)}>End</button>
          <button className="action-btn danger" onClick={() => onKill(proc, true)}>Force kill</button>
        </div>
      </div>
    </div>
  );
}

function DetailStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="process-detail-stat">
      <span className="process-detail-stat-value">{value}</span>
      <span className="process-detail-stat-label">{label}</span>
    </div>
  );
}

// ── Shared UI bits ─────────────────────────────────────────────────────────

function MemoryStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="memory-stat">
      <span className="memory-stat-value">{value}</span>
      <span className="memory-stat-label">{label}</span>
    </div>
  );
}

function SortHeader(props: {
  field: SortField;
  label: string;
  current: SortField;
  dir: SortDir;
  onToggle: (f: SortField) => void;
  align?: "left" | "right";
}) {
  const { field, label, current, dir, onToggle, align } = props;
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

function RefreshIntervalChip(props: {
  value: number;
  paused: boolean;
  onChange: (ms: number) => void;
  onTogglePause: () => void;
}) {
  const { value, paused, onChange, onTogglePause } = props;
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("click", onDoc);
    return () => document.removeEventListener("click", onDoc);
  }, [open]);

  const options: { label: string; value: number }[] = [
    { label: "2s",  value: 2_000 },
    { label: "5s",  value: 5_000 },
    { label: "10s", value: 10_000 },
    { label: "30s", value: 30_000 },
  ];

  return (
    <div className="memory-refresh-chip" ref={ref}>
      <button
        className={`chip ${paused ? "active" : ""}`}
        onClick={onTogglePause}
        title={paused ? "Resume auto-refresh" : "Pause auto-refresh"}
      >
        {paused ? "Paused" : `Auto ${value / 1000}s`}
      </button>
      {!paused && (
        <button
          className="memory-refresh-chevron"
          onClick={() => setOpen((v) => !v)}
          title="Change interval"
          aria-label="Change refresh interval"
        >
          <svg width="8" height="8" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.5">
            <path d="M2 4L5 7L8 4" />
          </svg>
        </button>
      )}
      {open && (
        <div className="memory-refresh-menu">
          {options.map((opt) => (
            <button
              key={opt.value}
              className={`memory-refresh-menu-item ${opt.value === value ? "active" : ""}`}
              onClick={() => { onChange(opt.value); setOpen(false); }}
            >
              {opt.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
