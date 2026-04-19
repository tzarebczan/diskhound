import { useCallback, useEffect, useMemo, useRef, useState } from "preact/hooks";

import type { ProcessInfo, SystemMemorySnapshot } from "../../shared/contracts";
import { formatBytes, formatCount } from "../lib/format";
import { nativeApi } from "../nativeApi";
import { ProcessIcon } from "./ProcessIcon";
import { toast } from "./Toasts";

type SortField = "memory" | "cpu" | "name" | "pid";
type SortDir = "asc" | "desc";
type ViewMode = "list" | "treemap";

const DEFAULT_REFRESH_MS = 5_000;
const MIN_REFRESH_MS = 2_000;
const MAX_REFRESH_MS = 30_000;
const VIEW_MODE_KEY = "diskhound:memory-view-mode";
const REFRESH_MS_KEY = "diskhound:memory-refresh-ms";

function getInitialViewMode(): ViewMode {
  if (typeof window === "undefined") return "list";
  return window.localStorage.getItem(VIEW_MODE_KEY) === "treemap" ? "treemap" : "list";
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
  const [lastSampleMs, setLastSampleMs] = useState<number | null>(null);
  const timerRef = useRef<number | null>(null);

  useEffect(() => {
    try { window.localStorage.setItem(VIEW_MODE_KEY, viewMode); } catch { /* ignore */ }
  }, [viewMode]);
  useEffect(() => {
    try { window.localStorage.setItem(REFRESH_MS_KEY, String(refreshMs)); } catch { /* ignore */ }
  }, [refreshMs]);

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
      ? snapshot.processes.filter((p) =>
          p.name.toLowerCase().includes(q) || String(p.pid).includes(q),
        )
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
        </div>
        <input
          className="filter-input"
          value={filter}
          onInput={(e) => setFilter((e.target as HTMLInputElement).value)}
          placeholder="Filter by name or PID..."
        />
        <div className="memory-toolbar-spacer" />
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
      {viewMode === "list" ? (
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
      ) : (
        <ProcessTreemap
          processes={visibleProcesses}
          totalBytes={snapshot.totalBytes}
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

  // Max memory used by any visible process — used to scale the memory bar
  // so the largest process fills the bar. Relative visualization is more
  // useful than absolute-to-total because most processes are <1% of RAM.
  const maxMem = processes.reduce((max, p) => Math.max(max, p.memoryBytes), 0);

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
        {processes.length === 0 ? (
          <div className="empty-view">
            <span>{filter ? "No processes match the filter" : `No processes visible (of ${total})`}</span>
          </div>
        ) : (
          processes.map((p) => (
            <ProcessRow
              key={p.pid}
              proc={p}
              maxMem={maxMem}
              totalBytes={totalBytes}
              isBusy={killingPid === p.pid}
              onKill={onKill}
            />
          ))
        )}
      </div>
    </>
  );
}

function ProcessRow(props: {
  proc: ProcessInfo;
  maxMem: number;
  totalBytes: number;
  isBusy: boolean;
  onKill: (p: ProcessInfo, hard: boolean) => void;
}) {
  const { proc, maxMem, totalBytes, isBusy, onKill } = props;
  const memPct = maxMem > 0 ? (proc.memoryBytes / maxMem) * 100 : 0;
  const totalPct = totalBytes > 0 ? (proc.memoryBytes / totalBytes) * 100 : 0;
  const memClass = totalPct > 5 ? "high" : totalPct > 1 ? "mid" : "low";

  return (
    <div
      className="memory-row"
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
        {proc.cpuPercent !== null ? `${proc.cpuPercent.toFixed(1)}%` : "—"}
      </div>
      <div className="memory-row-pid">{proc.pid}</div>
      <div className="memory-row-name">
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
 *  processes (e.g. all chrome.exe instances) group visually. */
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
      ctx.fillStyle = r.color;
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
      const maxLabelW = r.w - pad * 2;
      if (r.w > 44 && r.h > 20 && maxLabelW > 30) {
        const fontSize = Math.min(12, Math.max(8, Math.min(r.w / 10, r.h / 3)));
        ctx.font = `500 ${fontSize}px "JetBrains Mono", monospace`;
        ctx.textBaseline = "top";

        let label = r.process.name;
        let measured = ctx.measureText(label).width;
        if (measured > maxLabelW) {
          const charW = measured / label.length;
          const maxChars = Math.floor(maxLabelW / charW) - 1;
          label = maxChars > 2 ? label.slice(0, maxChars) + "\u2026" : "";
        }
        if (label) {
          ctx.fillStyle = "rgba(0,0,0,0.5)";
          ctx.fillText(label, r.x + pad + 1, r.y + pad + 1, maxLabelW);
          ctx.fillStyle = "rgba(255,255,255,0.95)";
          ctx.fillText(label, r.x + pad, r.y + pad, maxLabelW);
        }

        if (r.h > fontSize + pad * 2 + 10) {
          const sizeFont = Math.min(10, Math.max(7, fontSize - 2));
          ctx.font = `400 ${sizeFont}px "JetBrains Mono", monospace`;
          const sizeLabel = formatBytes(r.process.memoryBytes);
          ctx.fillStyle = "rgba(0,0,0,0.4)";
          ctx.fillText(sizeLabel, r.x + pad + 1, r.y + pad + fontSize + 2 + 1, maxLabelW);
          ctx.fillStyle = "rgba(255,255,255,0.75)";
          ctx.fillText(sizeLabel, r.x + pad, r.y + pad + fontSize + 2, maxLabelW);
        }
      }
    }
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
        style={{ cursor: hover ? "pointer" : "default" }}
      />
      {hover && !selected && (
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
