import { useCallback, useEffect, useMemo, useRef, useState } from "preact/hooks";

import type { AffinityRule, ProcessInfo, SystemMemorySnapshot } from "../../shared/contracts";
import { findMatchingRule } from "../lib/affinityMatch";
import { formatBytes, formatCount } from "../lib/format";
import { nativeApi } from "../nativeApi";
import { GpuView } from "./GpuView";
import {
  ProcessHeatmap,
  updateProcessHistory,
  type ProcessHistoryEntry,
} from "./ProcessHeatmap";
import { ProcessIcon } from "./ProcessIcon";
import { toast } from "./Toasts";

type SortField = "memory" | "cpu" | "name" | "pid";
type SortDir = "asc" | "desc";
type ViewMode = "list" | "treemap" | "heatmap" | "gpu" | "rules";
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
  // GPU (PowerShell Get-Counter against Windows WDDM) and CPU affinity
  // rules (SetProcessAffinityMask) are both Windows-only code paths.
  // If a user's last-saved mode was one of them and they've since
  // moved to Linux/Mac (or we're previewing on a new platform), we'd
  // land on an empty "unavailable" screen. Fall back to the list view
  // there so the tab is always useful on open.
  const isWin = nativeApi.platform === "win32";
  if (stored === "treemap") return "treemap";
  if (stored === "heatmap") return "heatmap";
  if (stored === "gpu" && isWin) return "gpu";
  if (stored === "rules" && isWin) return "rules";
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
  // Active affinity rules, poll-refreshed at a lower cadence than the
  // memory snapshot. ProcessRow uses this to badge rows whose exe name
  // matches a rule, and the context menu uses it to decide between
  // "Pin rule…" and "Edit rule…".
  const [affinityRules, setAffinityRules] = useState<AffinityRule[]>([]);
  useEffect(() => {
    const refresh = () => {
      void nativeApi.getAffinityRules().then((rules) => setAffinityRules(rules));
    };
    refresh();
    const id = window.setInterval(refresh, 5000);
    return () => window.clearInterval(id);
  }, []);
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

  // Pre-warm the process appearance cache as soon as a snapshot arrives,
  // regardless of which view is active. This fixes the "treemap shows
  // plain tiles, icons only appear after I switch tabs and come back"
  // complaint — by the time the user lands on the treemap view the
  // icons are likely already decoded and ready to paint. Bounded by
  // unique exePath count; the cache dedupes, so a Chrome-with-24-tabs
  // machine still only pays one IPC round trip for chrome.exe.
  useEffect(() => {
    if (!snapshot) return;
    for (const p of snapshot.processes) {
      if (!p.exePath) continue;
      loadProcessAppearance(p.exePath, colorForProcessName(p.name));
    }
  }, [snapshot]);

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

    // Map common permission-denied errors to actionable remediation.
    // Windows' taskkill emits "Access is denied" on protected / system-
    // owned processes; POSIX process.kill throws EPERM ("operation not
    // permitted") when we don't own the target. Each platform has a
    // different fix — spell it out instead of surfacing raw errno.
    const msg = (r?.message ?? "").toLowerCase();
    const deniedWin = msg.includes("access is denied") || msg.includes("access denied");
    const deniedPosix =
      msg.includes("eperm") ||
      msg.includes("operation not permitted") ||
      msg.includes("permission denied");
    if (deniedWin) {
      toast(
        "error",
        `Needs admin privileges`,
        `${proc.name} is a protected process. Close DiskHound, right-click its shortcut, choose "Run as administrator", then try again.`,
      );
    } else if (deniedPosix) {
      toast(
        "error",
        `Needs elevated privileges`,
        nativeApi.platform === "darwin"
          ? `${proc.name} is owned by another user or the system. Launch DiskHound with \`sudo open\`, or stop the process via Activity Monitor.`
          : `${proc.name} is owned by another user or the system. Relaunch DiskHound with \`sudo\`, or use \`sudo kill\` from a terminal.`,
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
          {/* GPU + Affinity Rules are Windows-only — the samplers rely
           * on PowerShell's Get-Counter (WDDM) and
           * SetProcessAffinityMask respectively, neither of which
           * has a macOS/Linux equivalent we ship. Hide the tabs
           * entirely there so users don't click into dead views. */}
          {nativeApi.platform === "win32" && (
            <>
              <button
                role="tab"
                aria-selected={viewMode === "gpu"}
                className={`memory-view-tab ${viewMode === "gpu" ? "active" : ""}`}
                onClick={() => setViewMode("gpu")}
                title="GPU — per-process GPU utilisation + VRAM, adapter overview"
              >
                {/* Stylised "GPU module" — a rounded rectangle card with
                    radiating heat lines, to distinguish from the Heatmap
                    icon and signal "hardware device" rather than "graph". */}
                <svg width="13" height="13" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.3">
                  <rect x="1.5" y="4" width="11" height="6" rx="1" />
                  <circle cx="5" cy="7" r="1.2" />
                  <path d="M4 1.5V3.5M7 1.5V3.5M10 1.5V3.5M4 10.5V12.5M7 10.5V12.5M10 10.5V12.5" opacity="0.6" />
                </svg>
                GPU
              </button>
              <button
                role="tab"
                aria-selected={viewMode === "rules"}
                className={`memory-view-tab ${viewMode === "rules" ? "active" : ""}`}
                onClick={() => setViewMode("rules")}
                title="CPU affinity rules — pin processes to specific cores persistently"
              >
                <svg width="13" height="13" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.3">
                  <rect x="1.5" y="1.5" width="4" height="4" />
                  <rect x="8.5" y="1.5" width="4" height="4" />
                  <rect x="1.5" y="8.5" width="4" height="4" />
                  <rect x="8.5" y="8.5" width="4" height="4" />
                  <path d="M5.5 3.5H8.5M5.5 10.5H8.5M3.5 5.5V8.5M10.5 5.5V8.5" opacity="0.5" />
                </svg>
                Affinity Rules
              </button>
            </>
          )}
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
          affinityRules={affinityRules}
          onRuleChanged={() => {
            void nativeApi.getAffinityRules().then(setAffinityRules);
          }}
        />
      )}
      {viewMode === "treemap" && (
        <ProcessTreemap
          processes={visibleProcesses}
          totalBytes={snapshot.totalBytes}
          onKill={kill}
          affinityRules={affinityRules}
          onRuleChanged={() => {
            void nativeApi.getAffinityRules().then(setAffinityRules);
          }}
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
          affinityRules={affinityRules}
          onKill={kill}
          onOpenContextMenu={openViewContextMenu}
        />
      )}
      {viewMode === "gpu" && <GpuView refreshMs={refreshMs} />}
      {viewMode === "rules" && (
        <AffinityRulesView cpuCount={snapshot.cpuCount} />
      )}

      {/* Shared context menu — heatmap opens it via callback; rendered at
       * the MemoryView level so a single Esc/click-away handler dismisses
       * regardless of which view was hot when it opened. */}
      {viewContextMenu && (
        <ProcessContextMenu
          x={viewContextMenu.x}
          y={viewContextMenu.y}
          proc={viewContextMenu.process}
          matchedRule={findMatchingRule(affinityRules, viewContextMenu.process)}
          onClose={closeViewContextMenu}
          onKill={kill}
          onRuleChanged={() => {
            void nativeApi.getAffinityRules().then(setAffinityRules);
          }}
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
  affinityRules: AffinityRule[];
  onRuleChanged: () => void;
}) {
  const { processes, total, totalBytes, filter, sortField, sortDir, onToggleSort, killingPid, onKill, affinityRules, onRuleChanged } = props;
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
                  affinityRule={findMatchingRule(affinityRules, p)}
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
                affinityRules={affinityRules}
                onRuleChanged={onRuleChanged}
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
  affinityRules: AffinityRule[];
  onRuleChanged: () => void;
}) {
  const { group, maxMem, totalBytes, isExpanded, onToggle, killingPid, onKill, affinityRules } = props;
  // Group-level rule match — if every member of this family matches the
  // same rule, we badge the group header too. Callers hitting Expand will
  // see per-child badges (which may differ in rare multi-pattern setups).
  const groupRule = findMatchingRule(affinityRules, group.processes[0]!);
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
          {groupRule && <AffinityRulePinIcon rule={groupRule} />}
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
          affinityRule={findMatchingRule(affinityRules, p)}
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
  affinityRule?: AffinityRule | null;
  isChild?: boolean;
}) {
  const { proc, maxMem, totalBytes, isBusy, onKill, affinityRule, isChild } = props;
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
        {affinityRule && <AffinityRulePinIcon rule={affinityRule} />}
        {!proc.userOwned && <span className="memory-row-system-badge" title="System process">sys</span>}
      </div>
      <div className="memory-row-actions">
        <button className="action-btn warn" disabled={isBusy} onClick={() => onKill(proc, false)} title="Graceful shutdown (SIGTERM/taskkill)">End</button>
        <button className="action-btn danger" disabled={isBusy} onClick={() => onKill(proc, true)} title="Force terminate (SIGKILL/taskkill /F)">Kill</button>
      </div>
    </div>
  );
}

/**
 * Small amber grid-pin icon rendered beside a process name when an
 * affinity rule is actively pinning it. Tooltip describes the rule
 * so users don't need to open the Rules tab to understand why their
 * process is constrained.
 *
 * Click-through is intentional — the icon itself doesn't handle click.
 * Right-click on the row opens the context menu which will offer
 * "Edit affinity rule…" (see ProcessContextMenu).
 */
function AffinityRulePinIcon({ rule }: { rule: AffinityRule }) {
  // Count set bits in the mask to summarise "pinned to N cores".
  let bits = 0;
  let mask = rule.affinityMask >>> 0;
  while (mask) {
    bits += mask & 1;
    mask >>>= 1;
  }
  const tooltip =
    `Affinity rule: ${rule.name || rule.matchPattern}\n` +
    `${rule.matchType === "exe_name" ? "Matches exe name" : "Matches path"}: ${rule.matchPattern}\n` +
    `Pinned to ${bits} core${bits === 1 ? "" : "s"}` +
    (rule.appliedCount > 0 ? ` · applied ${rule.appliedCount}×` : "");
  return (
    <span className="memory-row-affinity-pin" title={tooltip} aria-label="Affinity rule active">
      <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.2">
        <rect x="0.5" y="0.5" width="3.5" height="3.5" />
        <rect x="6"   y="0.5" width="3.5" height="3.5" />
        <rect x="0.5" y="6"   width="3.5" height="3.5" />
        <rect x="6"   y="6"   width="3.5" height="3.5" fill="currentColor" />
      </svg>
    </span>
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

/**
 * Okabe-Ito-derived palette used when Color-blind mode is on. Each
 * entry is either an Okabe-Ito canonical color or a subtle variation
 * that preserves perceptual distance under deuteranopia/protanopia/
 * tritanopia. No red-green pair anywhere.
 */
const COLOR_PALETTE_COLORBLIND = [
  "#0072b2", "#009e73", "#e69f00", "#d55e00", "#cc79a7",
  "#56b4e9", "#f0e442", "#925e9f", "#117733", "#332288",
  "#88ccee", "#999933", "#aa4499", "#44aa99", "#882255",
];

let processPaletteColorBlind = false;

export function setProcessPaletteColorBlind(on: boolean): void {
  processPaletteColorBlind = on;
}

function colorForProcessName(name: string): string {
  let h = 0;
  for (let i = 0; i < name.length; i++) {
    h = ((h << 5) - h + name.charCodeAt(i)) | 0;
  }
  const palette = processPaletteColorBlind ? COLOR_PALETTE_COLORBLIND : COLOR_PALETTE;
  return palette[Math.abs(h) % palette.length];
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
  affinityRules: AffinityRule[];
  onRuleChanged: () => void;
}) {
  const { processes, onKill, affinityRules, onRuleChanged } = props;
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rectsRef = useRef<TreemapRect[]>([]);
  // Counters for the "+N smaller processes" overflow strip — refs so
  // the canvas paint effect can update them without triggering a loop,
  // mirrored into state via an overflowSeq so the strip re-renders
  // when the numbers change.
  const overflowCountRef = useRef(0);
  const overflowBytesRef = useRef(0);
  const [overflowSeq, setOverflowSeq] = useState(0);
  const [dims, setDims] = useState({ w: 0, h: 0 });
  const [hover, setHover] = useState<{ x: number; y: number; process: ProcessInfo } | null>(null);
  const [selected, setSelected] = useState<ProcessInfo | null>(null);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; process: ProcessInfo } | null>(null);
  // Bumped whenever a new process icon / dominant color finishes loading
  // in the module cache. Kept as a real useState VALUE (not just a
  // discarded setter) so the paint effect can include it in its
  // dependency array — otherwise the subscription fires, the component
  // re-renders, but the paint effect sits with stale deps and the
  // canvas never repaints with the newly-resolved icons. That was the
  // bug behind "icons randomly appear after I leave and come back to
  // the tab."
  const [appearanceTick, setAppearanceTick] = useState(0);
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

    // Weight using sqrt for visual balance (same trick as the disk
    // treemap) so very large processes don't swallow the whole canvas.
    // Cap the treemap to TOP_N_PROCESSES tiles — on a typical Windows
    // machine there are 200-400 processes and anything past ~60 ends
    // up sub-icon-sized and label-less. The remainder is surfaced via
    // the "+N smaller processes" strip rendered below the canvas.
    const TOP_N_PROCESSES = 60;
    const sortedAll = [...processes]
      .filter((p) => p.memoryBytes > 0)
      .sort((a, b) => b.memoryBytes - a.memoryBytes);
    const sorted = sortedAll.slice(0, TOP_N_PROCESSES);
    const weighted = sorted.map((p) => ({ process: p, weight: Math.sqrt(p.memoryBytes) }));
    const totalWeight = weighted.reduce((s, i) => s + i.weight, 0);
    if (totalWeight === 0) {
      rectsRef.current = [];
      overflowCountRef.current = 0;
      overflowBytesRef.current = 0;
      return;
    }
    const newOverflowCount = sortedAll.length - sorted.length;
    const newOverflowBytes = sortedAll.slice(TOP_N_PROCESSES).reduce(
      (sum, p) => sum + p.memoryBytes, 0,
    );
    if (
      newOverflowCount !== overflowCountRef.current
      || newOverflowBytes !== overflowBytesRef.current
    ) {
      overflowCountRef.current = newOverflowCount;
      overflowBytesRef.current = newOverflowBytes;
      // Schedule a state bump in a microtask so we don't setState during
      // the paint effect body (which would be an update-while-rendering
      // warning in strict mode).
      queueMicrotask(() => setOverflowSeq((s) => s + 1));
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

      // Affinity-rule marker — amber corner triangle in the top-right,
      // sized so it's visible but doesn't compete with the label. Only
      // drawn on tiles big enough to read (16×16 minimum) so the user
      // isn't confused by a lone amber pixel on a sliver. The triangle
      // shape is intentionally distinct from any other treemap marker.
      if (r.w >= 16 && r.h >= 16) {
        const matchedRule = findMatchingRule(affinityRules, r.process);
        if (matchedRule) {
          const size = Math.min(14, Math.max(7, Math.floor(Math.min(r.w, r.h) * 0.11)));
          // dark underlay for contrast against light tile colors
          ctx.fillStyle = "rgba(0,0,0,0.55)";
          ctx.beginPath();
          ctx.moveTo(r.x + r.w - size - 2, r.y + 1);
          ctx.lineTo(r.x + r.w - 1,         r.y + 1);
          ctx.lineTo(r.x + r.w - 1,         r.y + size + 2);
          ctx.closePath();
          ctx.fill();
          // amber foreground — the recognizable rule colour
          ctx.fillStyle = "rgba(245, 158, 11, 0.96)";
          ctx.beginPath();
          ctx.moveTo(r.x + r.w - size - 1, r.y + 2);
          ctx.lineTo(r.x + r.w - 2,         r.y + 2);
          ctx.lineTo(r.x + r.w - 2,         r.y + size + 1);
          ctx.closePath();
          ctx.fill();
        }
      }
    }
    // Read the module counter for observability; the state-backed
    // `appearanceTick` in the deps below is what actually drives
    // repaints when icons resolve.
    void appearanceVersion;
  }, [processes, dims, appearanceTick, affinityRules]);

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
          matchedRule={findMatchingRule(affinityRules, contextMenu.process)}
          onClose={() => setContextMenu(null)}
          onKill={onKill}
          onRuleChanged={onRuleChanged}
        />
      )}
      {/* Overflow strip — renders only when the machine has more than
          our TOP_N_PROCESSES cap. Keeps the treemap proper focused on
          tiles big enough to show icons + names, and lets users know
          the smaller processes aren't missing — just in the List. */}
      {overflowCountRef.current > 0 && (
        <div className="memory-treemap-overflow" aria-live="polite">
          <span className="memory-treemap-overflow-label">
            +{overflowCountRef.current} smaller process{overflowCountRef.current === 1 ? "" : "es"}
          </span>
          <span className="memory-treemap-overflow-bytes">
            {formatBytes(overflowBytesRef.current)} combined
          </span>
          <span className="memory-treemap-overflow-hint">
            Use the List view to see them all
          </span>
        </div>
      )}
      {/* Reference overflowSeq so React sees it as a render dep and
          re-renders this tree when the counters change. The refs
          themselves aren't reactive, but the state bump forces a paint. */}
      {void overflowSeq}
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
  matchedRule: AffinityRule | null;
  onClose: () => void;
  onKill: (p: ProcessInfo, hard: boolean) => void;
  onRuleChanged: () => void;
}) {
  const { x, y, proc, matchedRule, onClose, onKill, onRuleChanged } = props;
  const menuRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x, y });
  const [affinityOpen, setAffinityOpen] = useState(false);
  const [pinRuleOpen, setPinRuleOpen] = useState(false);
  // When a rule already exists for this process, clicking "Edit
  // affinity rule…" opens the full editor pre-populated with the
  // existing rule. Separate from pinRuleOpen because editing uses a
  // different data source (the existing rule object, not a
  // freshly-computed mask).
  const [editRuleOpen, setEditRuleOpen] = useState(false);

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
      {/* CPU-affinity items are Windows-only — the backend calls
       * Win32 SetProcessAffinityMask via PowerShell. On Linux the
       * equivalent is sched_setaffinity + a per-process rule
       * engine we haven't built yet, and on macOS affinity isn't
       * exposed at all (the scheduler treats it as a hint at best).
       * Hide the items rather than showing ones that always fail. */}
      {nativeApi.platform === "win32" && (
        <>
          <button
            className="process-ctx-item"
            role="menuitem"
            onClick={() => setAffinityOpen(true)}
          >
            <svg width="12" height="12" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.3">
              <rect x="2" y="2" width="4" height="4" />
              <rect x="8" y="2" width="4" height="4" />
              <rect x="2" y="8" width="4" height="4" />
              <rect x="8" y="8" width="4" height="4" />
            </svg>
            Set CPU affinity… (once)
          </button>
          {matchedRule ? (
            <button
              className="process-ctx-item process-ctx-highlight"
              role="menuitem"
              onClick={() => setEditRuleOpen(true)}
              title={`Rule already exists: ${matchedRule.name || matchedRule.matchPattern}. Click to edit.`}
            >
              <svg width="12" height="12" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.3">
                <path d="M2 10L2 12L4 12L11 5L9 3L2 10Z" />
                <path d="M8.5 3.5L10.5 5.5" />
              </svg>
              Edit affinity rule…
            </button>
          ) : (
            <button
              className="process-ctx-item"
              role="menuitem"
              onClick={() => setPinRuleOpen(true)}
              title="Create a persistent rule that re-applies this affinity every time the process starts"
            >
              <svg width="12" height="12" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.3">
                <path d="M7 2L7 9M7 9L4 6M7 9L10 6" />
                <circle cx="7" cy="11.5" r="1" />
              </svg>
              Pin CPU affinity rule…
            </button>
          )}
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
      {affinityOpen && (
        <CpuAffinityDialog
          proc={proc}
          onClose={() => {
            setAffinityOpen(false);
            onClose();
          }}
        />
      )}
      {pinRuleOpen && <PinAffinityRuleDialog
        proc={proc}
        onClose={() => {
          setPinRuleOpen(false);
          onClose();
        }}
        onSaved={() => {
          onRuleChanged();
        }}
      />}
      {editRuleOpen && matchedRule && (
        <EditAffinityRuleDialog
          rule={matchedRule}
          onClose={() => {
            setEditRuleOpen(false);
            onClose();
          }}
          onSaved={() => {
            onRuleChanged();
          }}
        />
      )}
    </div>
  );
}

/**
 * Opens the AffinityRuleEditor seeded with an existing rule. Used from
 * the context menu when the process already matches a rule — the "take
 * me there" path that avoids creating a duplicate. Separate from
 * PinAffinityRuleDialog because we don't need to re-read the process's
 * current mask; the rule itself already has the intended mask.
 */
function EditAffinityRuleDialog({
  rule,
  onClose,
  onSaved,
}: {
  rule: AffinityRule;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [cpuCount, setCpuCount] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    // We need a cpu count for the editor's grid. Any PID works — use
    // the editor's dummy call just to read the count. If it fails we
    // still render with a best-guess 32-bit count (rule mask is 32-bit
    // anyway and Windows caps affinity groups at 64 CPUs).
    void nativeApi
      .getCpuAffinity(0)
      .then((res) => {
        if (cancelled) return;
        setCpuCount(res.cpuCount || 32);
      })
      .catch(() => {
        if (!cancelled) setCpuCount(32);
      });
    return () => { cancelled = true; };
  }, []);

  if (cpuCount === null) {
    return (
      <div className="cpu-affinity-overlay" onClick={onClose}>
        <div className="cpu-affinity-card" onClick={(e) => e.stopPropagation()}>
          <div className="cpu-affinity-loading">Loading rule editor…</div>
        </div>
      </div>
    );
  }

  return (
    <AffinityRuleEditor
      rule={rule}
      cpuCount={cpuCount}
      onClose={onClose}
      onSaved={() => {
        toast("success", "Affinity rule updated", rule.matchPattern);
        onSaved();
        onClose();
      }}
    />
  );
}

/**
 * Thin wrapper that seeds an AffinityRuleEditor with a process's
 * exe name + current affinity mask, and hands the os.cpus() count
 * through. Invoked from the Processes right-click menu.
 */
function PinAffinityRuleDialog({
  proc,
  onClose,
  onSaved,
}: {
  proc: ProcessInfo;
  onClose: () => void;
  onSaved?: () => void;
}) {
  const [rule, setRule] = useState<AffinityRule | null>(null);
  const [cpuCount, setCpuCount] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    // Fetch current affinity + cpu count in parallel so the editor
    // opens with "what this process is actually using right now" as
    // the pre-selected mask. Saves the user the step of figuring
    // out what to pin to.
    void nativeApi.getCpuAffinity(proc.pid).then((res) => {
      if (cancelled) return;
      const count = res.cpuCount || 1;
      const mask = res.ok && res.affinityMask !== undefined
        ? res.affinityMask
        : count >= 32 ? 0xFFFFFFFF : (1 << count) - 1;
      const basename = proc.exePath
        ? (proc.exePath.split(/[\\/]/).pop() || "").toLowerCase()
        : proc.name.toLowerCase();
      setCpuCount(count);
      setRule({
        id: typeof crypto !== "undefined" && "randomUUID" in crypto
          ? crypto.randomUUID()
          : `rule-${Date.now()}-${Math.random().toString(16).slice(2)}`,
        name: proc.name,
        enabled: true,
        matchType: "exe_name",
        matchPattern: basename,
        affinityMask: mask,
        createdAt: Date.now(),
        lastAppliedAt: null,
        appliedCount: 0,
      });
    });
    return () => { cancelled = true; };
  }, [proc.pid, proc.exePath, proc.name]);

  if (!rule || cpuCount === null) {
    return (
      <div className="cpu-affinity-overlay" onClick={onClose}>
        <div className="cpu-affinity-card" onClick={(e) => e.stopPropagation()}>
          <div className="cpu-affinity-loading">Reading current affinity…</div>
        </div>
      </div>
    );
  }

  return (
    <AffinityRuleEditor
      rule={rule}
      cpuCount={cpuCount}
      onClose={onClose}
      onSaved={() => {
        toast(
          "success",
          "Affinity rule created",
          `${rule.matchPattern} will re-pin every time it launches.`,
        );
        onSaved?.();
        onClose();
      }}
    />
  );
}

/**
 * Modal for editing a process's CPU affinity mask. Loads the current
 * mask on mount, renders one checkbox per logical CPU, applies on
 * Save. Cancel leaves the mask untouched. Zero-selection is rejected
 * client-side (a zero affinity mask would make the process unable to
 * run on anything).
 */
function CpuAffinityDialog({
  proc,
  onClose,
}: {
  proc: ProcessInfo;
  onClose: () => void;
}) {
  const [state, setState] = useState<
    | { phase: "loading" }
    | { phase: "ready"; cpuCount: number; selected: boolean[] }
    | { phase: "error"; message: string }
  >({ phase: "loading" });
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void nativeApi.getCpuAffinity(proc.pid).then((res) => {
      if (cancelled) return;
      if (!res.ok || res.affinityMask === undefined) {
        setState({ phase: "error", message: res.message ?? "Couldn't read affinity mask" });
        return;
      }
      const selected = Array.from({ length: res.cpuCount }, (_, i) => (res.affinityMask! & (1 << i)) !== 0);
      setState({ phase: "ready", cpuCount: res.cpuCount, selected });
    });
    return () => { cancelled = true; };
  }, [proc.pid]);

  const toggle = (i: number) => {
    if (state.phase !== "ready") return;
    const next = state.selected.slice();
    next[i] = !next[i];
    setState({ ...state, selected: next });
  };
  const selectAll = () => {
    if (state.phase !== "ready") return;
    setState({ ...state, selected: state.selected.map(() => true) });
  };
  const selectEven = () => {
    if (state.phase !== "ready") return;
    // Even-numbered cores often map to distinct physical cores on
    // hyperthreaded CPUs — restricting to evens gives the process
    // the wider of the pair and avoids sharing an L1 with an SMT
    // sibling. Common tuning trick for perf-sensitive workloads.
    setState({
      ...state,
      selected: state.selected.map((_, i) => i % 2 === 0),
    });
  };

  const save = async () => {
    if (state.phase !== "ready") return;
    const mask = state.selected.reduce(
      (acc, on, i) => (on ? acc | (1 << i) : acc),
      0,
    );
    if (mask === 0) {
      toast("error", "Select at least one CPU");
      return;
    }
    setSaving(true);
    const result = await nativeApi.setCpuAffinity(proc.pid, mask);
    setSaving(false);
    if (result.ok) {
      toast("success", "Affinity updated", `PID ${proc.pid} now restricted to ${state.selected.filter(Boolean).length} CPU(s)`);
      onClose();
    } else {
      toast("error", "Couldn't set affinity", result.message ?? "Check admin rights");
    }
  };

  return (
    <div className="cpu-affinity-overlay" onClick={onClose}>
      <div className="cpu-affinity-card" onClick={(e) => e.stopPropagation()}>
        <div className="cpu-affinity-header">
          <div className="cpu-affinity-title">CPU Affinity</div>
          <div className="cpu-affinity-sub">{proc.name} · PID {proc.pid}</div>
        </div>
        {state.phase === "loading" && (
          <div className="cpu-affinity-loading">Reading current mask…</div>
        )}
        {state.phase === "error" && (
          <div className="cpu-affinity-error">{state.message}</div>
        )}
        {state.phase === "ready" && (
          <>
            <div className="cpu-affinity-grid">
              {state.selected.map((on, i) => (
                <button
                  key={i}
                  className={`cpu-affinity-cell ${on ? "on" : "off"}`}
                  onClick={() => toggle(i)}
                  title={`CPU ${i}`}
                >
                  {i}
                </button>
              ))}
            </div>
            <div className="cpu-affinity-presets">
              <button className="action-btn" onClick={selectAll}>All cores</button>
              <button className="action-btn" onClick={selectEven}>Even cores only</button>
            </div>
          </>
        )}
        <div className="cpu-affinity-actions">
          <button className="action-btn" onClick={onClose} disabled={saving}>Cancel</button>
          <button
            className="action-btn primary"
            onClick={() => void save()}
            disabled={saving || state.phase !== "ready"}
          >
            {saving ? "Saving…" : "Apply"}
          </button>
        </div>
      </div>
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

/**
 * Affinity-rules management view. Lists all persistent rules, lets
 * the user toggle/edit/delete. Rules are evaluated by the backend on
 * every process-monitor tick (~4 s); this view is just a CRUD UI over
 * the list.
 *
 * Layout mirrors Process Lasso's dense rules table: one row per rule
 * with an enable checkbox, process name/pattern, CPU mask bits as a
 * compact pill, applied counter, and per-row actions. Empty state
 * points the user back at the Processes view and the right-click
 * flow to add their first rule.
 */
function AffinityRulesView({ cpuCount }: { cpuCount: number }) {
  const [rules, setRules] = useState<AffinityRule[] | null>(null);
  const [editingRule, setEditingRule] = useState<AffinityRule | null>(null);

  const reload = async () => {
    const next = await nativeApi.getAffinityRules();
    setRules(next);
  };

  useEffect(() => {
    void reload();
    // Light polling so "lastAppliedAt" / "appliedCount" update
    // reactively as the engine fires rules in the background. 3 s is
    // fast enough to feel live without hammering settings reads.
    const id = window.setInterval(() => { void reload(); }, 3000);
    return () => window.clearInterval(id);
  }, []);

  const toggleEnabled = async (rule: AffinityRule) => {
    const next: AffinityRule = { ...rule, enabled: !rule.enabled };
    await nativeApi.upsertAffinityRule(next);
    await reload();
  };
  const deleteRule = async (rule: AffinityRule) => {
    if (!window.confirm(`Delete affinity rule for "${rule.name}"?`)) return;
    await nativeApi.deleteAffinityRule(rule.id);
    await reload();
    toast("success", "Rule deleted");
  };

  if (rules === null) {
    return (
      <div className="affinity-rules-empty">
        <div>Loading rules…</div>
      </div>
    );
  }

  if (rules.length === 0) {
    return (
      <div className="affinity-rules-empty">
        <div className="affinity-rules-empty-title">No affinity rules yet</div>
        <div className="affinity-rules-empty-body">
          Pin a process to specific CPU cores persistently: switch to the
          <strong> List </strong> or <strong> CPU Heatmap </strong> tab,
          right-click a process, and choose <strong>Pin CPU affinity…</strong>.
          DiskHound will re-apply the mask every time that executable
          launches.
        </div>
      </div>
    );
  }

  const enabledCount = rules.filter((r) => r.enabled).length;
  return (
    <div className="affinity-rules-view">
      <div className="affinity-rules-header">
        <div className="affinity-rules-summary">
          <strong>{rules.length}</strong> rule{rules.length === 1 ? "" : "s"}
          {" · "}
          <span className={enabledCount === 0 ? "affinity-rules-dim" : ""}>
            {enabledCount} active
          </span>
        </div>
        <button
          className="action-btn"
          onClick={() => setEditingRule(createEmptyRule(cpuCount))}
        >
          + Add rule
        </button>
      </div>
      <div className="affinity-rules-table">
        <div className="affinity-rules-table-head">
          <span className="affinity-rules-col-enabled" />
          <span className="affinity-rules-col-name">Process</span>
          <span className="affinity-rules-col-pattern">Pattern</span>
          <span className="affinity-rules-col-mask">Affinity</span>
          <span className="affinity-rules-col-applied">Applied</span>
          <span className="affinity-rules-col-actions" />
        </div>
        {rules.map((rule) => (
          <AffinityRuleRow
            key={rule.id}
            rule={rule}
            cpuCount={cpuCount}
            onToggle={() => void toggleEnabled(rule)}
            onEdit={() => setEditingRule(rule)}
            onDelete={() => void deleteRule(rule)}
          />
        ))}
      </div>

      {editingRule && (
        <AffinityRuleEditor
          rule={editingRule}
          cpuCount={cpuCount}
          onClose={() => setEditingRule(null)}
          onSaved={async () => {
            setEditingRule(null);
            await reload();
          }}
        />
      )}
    </div>
  );
}

function AffinityRuleRow({
  rule,
  cpuCount,
  onToggle,
  onEdit,
  onDelete,
}: {
  rule: AffinityRule;
  cpuCount: number;
  onToggle: () => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  return (
    <div className={`affinity-rules-row ${rule.enabled ? "" : "disabled"}`}>
      <span className="affinity-rules-col-enabled">
        <input
          type="checkbox"
          checked={rule.enabled}
          onChange={onToggle}
          title={rule.enabled ? "Disable rule" : "Enable rule"}
        />
      </span>
      <span className="affinity-rules-col-name" title={rule.name}>
        {rule.name}
      </span>
      <span className="affinity-rules-col-pattern">
        <span className={`affinity-rules-badge match-${rule.matchType}`}>
          {rule.matchType === "exe_name" ? "exe" : "path"}
        </span>
        <span className="affinity-rules-pattern" title={rule.matchPattern}>
          {rule.matchPattern}
        </span>
      </span>
      <span className="affinity-rules-col-mask">
        <AffinityMaskBits mask={rule.affinityMask} cpuCount={cpuCount} />
      </span>
      <span className="affinity-rules-col-applied">
        <span className="affinity-rules-count">{rule.appliedCount}</span>
        {rule.lastAppliedAt && (
          <span className="affinity-rules-applied-time">
            {formatRelativeTime(rule.lastAppliedAt)}
          </span>
        )}
      </span>
      <span className="affinity-rules-col-actions">
        <button className="action-btn" onClick={onEdit} title="Edit rule">
          Edit
        </button>
        <button className="action-btn danger" onClick={onDelete} title="Delete rule">
          Delete
        </button>
      </span>
    </div>
  );
}

/**
 * Compact per-CPU bit visualization. Lit square = CPU allowed, empty
 * square = CPU blocked. Much denser than a text mask and faster to
 * read than a comma list at a glance. Caps at 32 dots to keep the row
 * height bounded on Threadripper-class boxes (64 / 128 cores would
 * wrap otherwise).
 */
function AffinityMaskBits({ mask, cpuCount }: { mask: number; cpuCount: number }) {
  const n = Math.min(cpuCount, 32);
  const bits: boolean[] = [];
  for (let i = 0; i < n; i++) bits.push((mask & (1 << i)) !== 0);
  const all = bits.every((b) => b);
  if (all && cpuCount <= 32) {
    return <span className="affinity-rules-mask all-cores">ALL</span>;
  }
  return (
    <span className="affinity-rules-mask" title={`mask=0x${mask.toString(16)}`}>
      {bits.map((on, i) => (
        <span key={i} className={`affinity-rules-bit ${on ? "on" : "off"}`} />
      ))}
      {cpuCount > 32 && (
        <span className="affinity-rules-mask-overflow">+{cpuCount - 32}</span>
      )}
    </span>
  );
}

function formatRelativeTime(ts: number): string {
  const delta = Date.now() - ts;
  if (delta < 0) return "just now";
  const seconds = Math.floor(delta / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function createEmptyRule(cpuCount: number): AffinityRule {
  // Default new rules to "all cores" so saving without touching the
  // cells writes the same mask the process already has. Users then
  // toggle off the cores they want to exclude.
  const mask = cpuCount >= 32 ? 0xFFFFFFFF : (1 << cpuCount) - 1;
  return {
    id: typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : `rule-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    name: "",
    enabled: true,
    matchType: "exe_name",
    matchPattern: "",
    affinityMask: mask,
    createdAt: Date.now(),
    lastAppliedAt: null,
    appliedCount: 0,
  };
}

/**
 * Modal for creating or editing an affinity rule. Shared between the
 * "+ Add rule" button in the rules view and the context-menu's
 * "Pin affinity…" flow (which pre-populates from a selected process).
 */
function AffinityRuleEditor({
  rule,
  cpuCount,
  onClose,
  onSaved,
}: {
  rule: AffinityRule;
  cpuCount: number;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState(rule.name);
  const [matchType, setMatchType] = useState(rule.matchType);
  const [matchPattern, setMatchPattern] = useState(rule.matchPattern);
  const [selected, setSelected] = useState<boolean[]>(() => {
    const n = cpuCount;
    return Array.from({ length: n }, (_, i) => (rule.affinityMask & (1 << i)) !== 0);
  });
  const [saving, setSaving] = useState(false);

  const toggle = (i: number) => {
    const next = selected.slice();
    next[i] = !next[i];
    setSelected(next);
  };
  const selectAll = () => setSelected(selected.map(() => true));
  const selectNone = () => setSelected(selected.map(() => false));
  const selectEven = () => setSelected(selected.map((_, i) => i % 2 === 0));

  const save = async () => {
    const trimmedPattern = matchPattern.trim().toLowerCase();
    if (!trimmedPattern) {
      toast("error", "Pattern required", "Enter an exe name or path substring");
      return;
    }
    const mask = selected.reduce((acc, on, i) => (on ? acc | (1 << i) : acc), 0);
    if (mask === 0) {
      toast("error", "Select at least one CPU");
      return;
    }
    setSaving(true);
    const next: AffinityRule = {
      ...rule,
      name: name.trim() || trimmedPattern,
      matchType,
      matchPattern: trimmedPattern,
      affinityMask: mask,
    };
    const result = await nativeApi.upsertAffinityRule(next);
    setSaving(false);
    if (result.ok) {
      toast("success", "Rule saved");
      onSaved();
    } else {
      toast("error", "Couldn't save rule", result.message);
    }
  };

  return (
    <div className="cpu-affinity-overlay" onClick={onClose}>
      <div className="cpu-affinity-card affinity-rule-editor" onClick={(e) => e.stopPropagation()}>
        <div className="cpu-affinity-header">
          <div className="cpu-affinity-title">
            {rule.appliedCount === 0 && rule.lastAppliedAt === null && !rule.name
              ? "New affinity rule"
              : `Edit rule: ${rule.name || rule.matchPattern}`}
          </div>
          <div className="cpu-affinity-sub">
            The rule re-applies every ~4 s against running processes.
          </div>
        </div>

        <div className="affinity-rule-field">
          <label>Match on</label>
          <div className="affinity-rule-match-toggle">
            <button
              type="button"
              className={`affinity-rule-match-btn ${matchType === "exe_name" ? "active" : ""}`}
              onClick={() => setMatchType("exe_name")}
            >
              Executable name
            </button>
            <button
              type="button"
              className={`affinity-rule-match-btn ${matchType === "exe_path" ? "active" : ""}`}
              onClick={() => setMatchType("exe_path")}
            >
              Path substring
            </button>
          </div>
        </div>

        <div className="affinity-rule-field">
          <label>
            {matchType === "exe_name" ? "Exe name (case-insensitive)" : "Path substring"}
          </label>
          <input
            className="filter-input"
            value={matchPattern}
            onInput={(e) => setMatchPattern((e.target as HTMLInputElement).value)}
            placeholder={matchType === "exe_name" ? "chrome.exe" : "\\node_modules\\"}
            autoFocus
          />
        </div>

        <div className="affinity-rule-field">
          <label>Display name (optional)</label>
          <input
            className="filter-input"
            value={name}
            onInput={(e) => setName((e.target as HTMLInputElement).value)}
            placeholder="Defaults to pattern"
          />
        </div>

        <div className="affinity-rule-field">
          <label>Allowed CPUs</label>
          <div className="cpu-affinity-grid">
            {selected.map((on, i) => (
              <button
                key={i}
                className={`cpu-affinity-cell ${on ? "on" : "off"}`}
                onClick={() => toggle(i)}
                title={`CPU ${i}`}
              >
                {i}
              </button>
            ))}
          </div>
          <div className="cpu-affinity-presets">
            <button className="action-btn" onClick={selectAll}>All</button>
            <button className="action-btn" onClick={selectNone}>None</button>
            <button className="action-btn" onClick={selectEven}>Even only</button>
          </div>
        </div>

        <div className="cpu-affinity-actions">
          <button className="action-btn" onClick={onClose} disabled={saving}>Cancel</button>
          <button
            className="action-btn primary"
            onClick={() => void save()}
            disabled={saving}
          >
            {saving ? "Saving…" : "Save rule"}
          </button>
        </div>
      </div>
    </div>
  );
}
