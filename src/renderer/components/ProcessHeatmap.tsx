import { useCallback, useEffect, useMemo, useRef, useState } from "preact/hooks";

import type { AffinityRule, ProcessInfo, SystemMemorySnapshot } from "../../shared/contracts";
import { findMatchingRule } from "../lib/affinityMatch";
import { ProcessIcon } from "./ProcessIcon";

/**
 * "The Pulse" — a scrolling CPU heatmap where the right edge is NOW and
 * time flows leftward into history. Each row is a process, each column is
 * a single sample tick, and the cell colour + optional sparkline overlay
 * tell you both "who's hot right now" and "who spiked recently" in one
 * glance.
 *
 * Rendered as a hybrid:
 * - DOM label column (220px) for process icons / names / avg-CPU bars /
 *   spike glyphs — easy to style + wire right-click to without
 *   canvas-side hit testing.
 * - Canvas for the heatmap grid + sparkline overlays — performance
 *   matters here (30 rows × 60 cols redrawn per tick = 1800 cells).
 * - DOM time-axis + legend below the canvas for accurate text anti-
 *   aliasing.
 *
 * History lives in a Map<pid, ProcessHistoryEntry> that the parent
 * maintains (so it survives tab-switches between List / Treemap /
 * Heatmap without being lost).
 */

// ── Config ─────────────────────────────────────────────────────────────────

export const HEATMAP_MAX_SAMPLES = 60;
const GHOST_LIFETIME_SAMPLES = 10;
const ROW_HEIGHT = 22;
const ROW_GAP = 1;
const LABEL_COL_WIDTH = 220;
const SPIKE_DELTA_PCT = 50;
const SPIKE_BASELINE_SAMPLES = 5;
const SPIKE_VISIBLE_FOR_SAMPLES = 3;
const MIN_SAMPLES_TO_RENDER = 2;
const RECOMMENDED_SAMPLES = 10;

// ── Types ──────────────────────────────────────────────────────────────────

export interface ProcessHistoryEntry {
  pid: number;
  name: string;
  exePath: string | null;
  /** Oldest-first. `null` means "process wasn't in the snapshot that tick". */
  samples: (number | null)[];
  /** Parallel to samples — wall-clock ms timestamps for tooltips. */
  sampleTimes: number[];
  /** Counts consecutive ticks we haven't seen this PID (for ghosting). */
  missingStreak: number;
  /** Last ProcessInfo we saw — needed for Kill actions via the existing IPC. */
  lastInfo: ProcessInfo;
}

interface HeatmapRow {
  entry: ProcessHistoryEntry;
  avg: number;
  max: number;
  last: number;
  hasRecentSpike: boolean;
}

interface HoverCell {
  row: ProcessHistoryEntry;
  sampleIdx: number;
  cpu: number | null;
  /** How many ticks back from "now" this hover cell sits. Needed so the
   *  tooltip can scale through Active mode's per-tick divisor at the
   *  correct column. 0 = newest tick. */
  ticksBack: number;
  time: number;
  clientX: number;
  clientY: number;
}

interface ContextTarget {
  row: ProcessHistoryEntry;
  x: number;
  y: number;
}

// ── History management (exported for MemoryView to call on each sample) ──

/**
 * Append the current snapshot to each process's rolling history, create
 * entries for new processes, and age-out processes that vanished more
 * than GHOST_LIFETIME_SAMPLES ticks ago.
 *
 * Uses the snapshot's sampledAt as the tick timestamp — if the same
 * snapshot arrives twice (e.g. from the cached IPC read on mount), we
 * bail on the second call so history doesn't get double-counted.
 */
export function updateProcessHistory(
  history: Map<number, ProcessHistoryEntry>,
  snapshot: SystemMemorySnapshot,
  lastSampledAtRef: { value: number },
): boolean {
  if (snapshot.sampledAt === lastSampledAtRef.value) return false;
  lastSampledAtRef.value = snapshot.sampledAt;

  const seen = new Set<number>();
  const t = snapshot.sampledAt;

  for (const proc of snapshot.processes) {
    seen.add(proc.pid);
    let entry = history.get(proc.pid);
    if (!entry) {
      entry = {
        pid: proc.pid,
        name: proc.name,
        exePath: proc.exePath ?? null,
        samples: [],
        sampleTimes: [],
        missingStreak: 0,
        lastInfo: proc,
      };
      history.set(proc.pid, entry);
    }
    // Store the RAW per-core value in history — the renderer scales to
    // "system %" at display time when the user has the system scale
    // selected. Storing the raw value lets users flip the scale toggle
    // without any history regeneration.
    entry.samples.push(proc.cpuPercentPerCore ?? 0);
    entry.sampleTimes.push(t);
    entry.name = proc.name;
    entry.exePath = proc.exePath ?? entry.exePath;
    entry.lastInfo = proc;
    entry.missingStreak = 0;
    if (entry.samples.length > HEATMAP_MAX_SAMPLES) {
      entry.samples.shift();
      entry.sampleTimes.shift();
    }
  }

  // Ghost-then-drop for processes we didn't see this tick.
  for (const [pid, entry] of history) {
    if (seen.has(pid)) continue;
    entry.samples.push(null);
    entry.sampleTimes.push(t);
    entry.missingStreak += 1;
    if (entry.samples.length > HEATMAP_MAX_SAMPLES) {
      entry.samples.shift();
      entry.sampleTimes.shift();
    }
    if (entry.missingStreak > GHOST_LIFETIME_SAMPLES) {
      history.delete(pid);
    }
  }

  return true;
}

// ── Helpers ────────────────────────────────────────────────────────────────

/**
 * Stepped color scale for cpu%. A smooth gradient would blur the zones;
 * stepped makes "30%+ territory" visually distinct. Values outside 0-100
 * clamp to the ends.
 */
function colorForCpu(cpu: number): string {
  if (cpu <= 0) return "rgba(10, 10, 20, 0.2)";
  if (cpu <= 5) return "#134e4a";
  if (cpu <= 15) return "#0d9488";
  if (cpu <= 30) return "#d97706";
  if (cpu <= 60) return "#dc2626";
  return "#fbbf24";
}

/**
 * Compute row aggregates AFTER scaling each sample through the active-
 * mode-aware `scaleFn`. We can't "scale the aggregate" because Active
 * mode uses a different divisor per tick, so we scale each sample
 * first, then aggregate the scaled values. Overall mode is a constant
 * divisor (cpuCount) so it could short-circuit, but the extra loop is
 * cheap and keeps the code path unified.
 */
function computeRow(
  entry: ProcessHistoryEntry,
  scaleFn: (v: number, ticksBack: number) => number,
): HeatmapRow {
  const len = entry.samples.length;
  const scaled: number[] = [];
  for (let i = 0; i < len; i++) {
    const s = entry.samples[i];
    if (typeof s !== "number") continue;
    scaled.push(scaleFn(s, len - 1 - i));
  }
  let avg = 0;
  let max = 0;
  if (scaled.length > 0) {
    let sum = 0;
    for (const s of scaled) {
      sum += s;
      if (s > max) max = s;
    }
    avg = sum / scaled.length;
  }
  const last = scaled[scaled.length - 1] ?? 0;

  // Spike detection operates on SCALED values so the threshold means
  // the same thing the user sees. In Overall mode, "+50" = CPU
  // utilization jumped 50 points; in Active mode, "+50" = process's
  // share of current load jumped 50 points. Both are interesting.
  let hasRecentSpike = false;
  for (let i = Math.max(0, scaled.length - SPIKE_VISIBLE_FOR_SAMPLES); i < scaled.length; i++) {
    const cur = scaled[i]!;
    const from = Math.max(0, i - SPIKE_BASELINE_SAMPLES);
    const baselineWindow = scaled.slice(from, i);
    if (baselineWindow.length < 2) continue;
    const baseline = baselineWindow.reduce((acc, v) => acc + v, 0) / baselineWindow.length;
    if (cur - baseline >= SPIKE_DELTA_PCT) {
      hasRecentSpike = true;
      break;
    }
  }

  return { entry, avg, max, last, hasRecentSpike };
}

// ── Component ──────────────────────────────────────────────────────────────

interface Props {
  history: Map<number, ProcessHistoryEntry>;
  /**
   * Per-tick total of per-core CPU activity, kept in the same rolling-
   * window shape as each entry's `samples` array. Used by "active"
   * scale to divide a sample by the total at that same tick so the
   * colored bands represent a process's SHARE of current load rather
   * than its absolute utilization.
   */
  historyTotals: number[];
  /** How many samples we've collected so far — drives loading copy. */
  sampleCount: number;
  filter: string;
  /**
   * CPU scale:
   * - "overall": divide by cpuCount so 0-100 matches Task Manager.
   *   Idle machine = near-zero everywhere.
   * - "active": divide by the per-tick total so busy processes sum
   *   to ~100%. Highlights WHO is driving the current load,
   *   regardless of how much machine is in use.
   */
  cpuScale: "overall" | "active";
  cpuCount: number;
  onKill: (p: ProcessInfo, hard: boolean) => void;
  /** Right-click on a row should open the same compact menu the treemap uses. */
  onOpenContextMenu: (p: ProcessInfo, x: number, y: number) => void;
  /**
   * Active affinity rules — used to badge rows whose process matches
   * an existing rule with a small amber pin icon in the label column.
   * Kept in sync with the rules tab via the same polling cadence
   * MemoryView uses for the List + Treemap views.
   */
  affinityRules: AffinityRule[];
}

export function ProcessHeatmap({
  history,
  historyTotals,
  sampleCount,
  filter,
  cpuScale,
  cpuCount,
  onKill,
  onOpenContextMenu,
  affinityRules,
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [dims, setDims] = useState({ w: 0, h: 0 });
  const [hover, setHover] = useState<HoverCell | null>(null);
  const rowsRef = useRef<HeatmapRow[]>([]);

  // Scale a raw-per-core sample to the currently-chosen display mode.
  //
  // Because "active" needs the PER-TICK total (different divisor per
  // time column), we take a sample and its index-from-most-recent
  // rather than just a value. "overall" ignores the index — divisor is
  // constant (cpuCount). Index is measured as "ticks back from the
  // newest tick," where 0 = newest.
  const scale = cpuScale === "overall"
    ? (v: number, _ticksBack: number) =>
        cpuCount > 0 ? Math.min(100, v / cpuCount) : Math.min(100, v)
    : (v: number, ticksBack: number) => {
        const totalIdx = historyTotals.length - 1 - ticksBack;
        const total = totalIdx >= 0 ? historyTotals[totalIdx] : 0;
        if (!total || total <= 0) return 0;
        return Math.min(100, (v / total) * 100);
      };

  // Observe the canvas container to keep dims in sync with the stage
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const e = entries[0];
      if (!e) return;
      const { width, height } = e.contentRect;
      setDims({ w: Math.floor(width), h: Math.floor(height) });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Which rows to show, in what order. Sort by max(cpu) over the window so
  // recent spikers bubble up. Apply filter. Cap to however many fit in the
  // canvas height minus the time-axis row.
  const rows = useMemo(() => {
    const rowCount = Math.max(1, Math.floor(dims.h / (ROW_HEIGHT + ROW_GAP)));
    const q = filter.trim().toLowerCase();
    const computed: HeatmapRow[] = [];
    for (const entry of history.values()) {
      if (q && !entry.name.toLowerCase().includes(q) && String(entry.pid) !== q) continue;
      if (entry.samples.every((s) => s === null || s === 0)) continue;
      computed.push(computeRow(entry, scale));
    }
    computed.sort((a, b) => b.max - a.max);
    return computed.slice(0, rowCount);
  }, [history, filter, dims.h]);
  rowsRef.current = rows;

  // Paint the grid + sparklines + live NOW marker every time history or
  // dims change. The sample count of the snapshot drives column count.
  const visibleSampleCount = Math.min(HEATMAP_MAX_SAMPLES, sampleCount);
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || dims.w === 0 || dims.h === 0) return;
    if (visibleSampleCount < MIN_SAMPLES_TO_RENDER) return;

    const dpr = typeof window !== "undefined" ? Math.min(window.devicePixelRatio || 1, 2) : 1;
    canvas.width = dims.w * dpr;
    canvas.height = dims.h * dpr;
    canvas.style.width = `${dims.w}px`;
    canvas.style.height = `${dims.h}px`;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, dims.w, dims.h);

    const cellW = dims.w / visibleSampleCount;
    const innerRowH = ROW_HEIGHT - ROW_GAP;

    for (let r = 0; r < rows.length; r++) {
      const row = rows[r]!;
      const y = r * (ROW_HEIGHT + ROW_GAP);
      const samples = row.entry.samples;
      const offset = samples.length - visibleSampleCount;

      // ── Cells ── colours + sparkline use scale() with an explicit
      // ticksBack so Active mode's per-tick divisor lines up correctly
      // with each column.
      for (let col = 0; col < visibleSampleCount; col++) {
        const idx = offset + col;
        if (idx < 0) continue;
        const rawCpu = samples[idx];
        if (rawCpu === null || rawCpu === undefined) continue;
        const ticksBack = samples.length - 1 - idx;
        ctx.fillStyle = colorForCpu(scale(rawCpu, ticksBack));
        ctx.fillRect(col * cellW, y, Math.ceil(cellW) + 0.5, innerRowH);
      }

      // ── Sparkline overlay ── thin, translucent, drawn through cell
      // centers so it adds trajectory info without fighting the cells
      // for visual weight.
      ctx.strokeStyle = "rgba(255, 255, 255, 0.22)";
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      let first = true;
      for (let col = 0; col < visibleSampleCount; col++) {
        const idx = offset + col;
        if (idx < 0) continue;
        const rawCpu = samples[idx];
        if (rawCpu === null || rawCpu === undefined) continue;
        const ticksBack = samples.length - 1 - idx;
        const cx = col * cellW + cellW / 2;
        const norm = Math.min(100, Math.max(0, scale(rawCpu, ticksBack))) / 100;
        // Clamp line 2px inside the row top/bottom so strokes don't visually
        // straddle the neighboring rows.
        const cy = y + 2 + (1 - norm) * (innerRowH - 4);
        if (first) { ctx.moveTo(cx, cy); first = false; }
        else { ctx.lineTo(cx, cy); }
      }
      ctx.stroke();

      // ── Row bottom separator ──
      ctx.strokeStyle = "rgba(255, 255, 255, 0.04)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(0, y + ROW_HEIGHT - 0.5);
      ctx.lineTo(dims.w, y + ROW_HEIGHT - 0.5);
      ctx.stroke();
    }

    // Live NOW marker — thin amber line at the rightmost column, drawn
    // last so it sits on top of everything.
    ctx.strokeStyle = "rgba(245, 158, 11, 0.55)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(dims.w - 0.5, 0);
    ctx.lineTo(dims.w - 0.5, rows.length * (ROW_HEIGHT + ROW_GAP));
    ctx.stroke();
  }, [rows, dims, visibleSampleCount, scale]);

  // ── Interactions: hover → tooltip ──
  const handleMouseMove = useCallback((e: MouseEvent) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    const rowIdx = Math.floor(my / (ROW_HEIGHT + ROW_GAP));
    const row = rowsRef.current[rowIdx];
    if (!row) {
      setHover(null);
      return;
    }
    const cellW = dims.w / Math.max(1, visibleSampleCount);
    const col = Math.floor(mx / cellW);
    if (col < 0 || col >= visibleSampleCount) {
      setHover(null);
      return;
    }
    const idx = row.entry.samples.length - visibleSampleCount + col;
    if (idx < 0 || idx >= row.entry.samples.length) {
      setHover(null);
      return;
    }
    setHover({
      row: row.entry,
      sampleIdx: idx,
      cpu: row.entry.samples[idx] ?? null,
      ticksBack: row.entry.samples.length - 1 - idx,
      time: row.entry.sampleTimes[idx] ?? 0,
      clientX: e.clientX,
      clientY: e.clientY,
    });
  }, [dims.w, visibleSampleCount]);

  const handleMouseLeave = useCallback(() => setHover(null), []);

  const handleContextMenu = useCallback((e: MouseEvent) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const my = e.clientY - rect.top;
    const rowIdx = Math.floor(my / (ROW_HEIGHT + ROW_GAP));
    const row = rowsRef.current[rowIdx];
    if (!row) return;
    e.preventDefault();
    e.stopPropagation();
    onOpenContextMenu(row.entry.lastInfo, e.clientX, e.clientY);
  }, [onOpenContextMenu]);

  // ── Empty / loading states ──
  if (sampleCount < MIN_SAMPLES_TO_RENDER) {
    return (
      <div className="process-heatmap">
        <div className="process-heatmap-loading">
          <div className="process-heatmap-loading-pulse" />
          <div className="process-heatmap-loading-title">Gathering samples…</div>
          <div className="process-heatmap-loading-sub">
            {sampleCount} / {RECOMMENDED_SAMPLES} — the heatmap starts drawing after a
            couple of samples, and fills out over the first 50 seconds.
          </div>
        </div>
      </div>
    );
  }

  const isWarmingUp = sampleCount < RECOMMENDED_SAMPLES;

  return (
    <div className="process-heatmap">
      {isWarmingUp && (
        <div className="process-heatmap-warmup">
          Warming up — {sampleCount}/{RECOMMENDED_SAMPLES} samples collected.
        </div>
      )}
      <div className="process-heatmap-body" style={{ gridTemplateColumns: `${LABEL_COL_WIDTH}px 1fr` }}>
        {/* ── Label column (DOM) ── */}
        <div className="process-heatmap-labels">
          {rows.map((row) => (
            <HeatmapRowLabel
              key={row.entry.pid}
              row={row}
              scaleLabel={cpuScale}
              matchedRule={findMatchingRule(affinityRules, row.entry.lastInfo)}
              onKill={onKill}
              onContextMenu={(p, x, y) => onOpenContextMenu(p, x, y)}
            />
          ))}
        </div>

        {/* ── Canvas (heatmap grid) ── */}
        <div className="process-heatmap-canvas-wrap" ref={containerRef}>
          <canvas
            ref={canvasRef}
            onMouseMove={handleMouseMove}
            onMouseLeave={handleMouseLeave}
            onContextMenu={handleContextMenu}
          />
          {/* CSS-animated pulse overlaying the rightmost "now" column */}
          <div className="process-heatmap-pulse" aria-hidden="true" />
          {hover && (
            <HeatmapTooltip hover={hover} scale={scale} scaleLabel={cpuScale} />
          )}
        </div>
      </div>

      {/* ── Footer: time axis + legend ── */}
      <div className="process-heatmap-footer">
        <div className="process-heatmap-axis" style={{ paddingLeft: LABEL_COL_WIDTH }}>
          <TimeAxis sampleCount={visibleSampleCount} />
        </div>
        <Legend />
      </div>
    </div>
  );
}

// ── Sub-components ─────────────────────────────────────────────────────────

function HeatmapRowLabel(props: {
  row: HeatmapRow;
  scaleLabel: "overall" | "active";
  matchedRule: AffinityRule | null;
  onKill: (p: ProcessInfo, hard: boolean) => void;
  onContextMenu: (p: ProcessInfo, x: number, y: number) => void;
}) {
  const { row, scaleLabel, matchedRule, onContextMenu } = props;
  const entry = row.entry;
  const isGhost = entry.missingStreak > 0;
  // row.avg/max/last are pre-scaled by computeRow() — no double-scaling here.
  const { avg, max, last } = row;
  const scaleHint = scaleLabel === "overall" ? "overall" : "share of active";
  return (
    <div
      className={`process-heatmap-label ${isGhost ? "ghost" : ""}`}
      title={`${entry.name} · PID ${entry.pid} (${scaleHint})\navg ${avg.toFixed(1)}% · max ${max.toFixed(1)}% · last ${last.toFixed(1)}%${
        matchedRule ? `\npinned by rule: ${matchedRule.name || matchedRule.matchPattern}` : ""
      }`}
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
        onContextMenu(entry.lastInfo, (e as MouseEvent).clientX, (e as MouseEvent).clientY);
      }}
    >
      <div
        className="process-heatmap-avg-bar"
        style={{ background: colorForCpu(avg) }}
        title={`Avg ${avg.toFixed(1)}% (${scaleHint})`}
      />
      <ProcessIcon exePath={entry.exePath} className="process-heatmap-icon" />
      <span className="process-heatmap-name">{entry.name}</span>
      {matchedRule && (
        <span
          className="process-heatmap-pin"
          aria-label="Affinity rule active"
          title={`Pinned by rule: ${matchedRule.name || matchedRule.matchPattern}`}
        >
          <svg width="9" height="9" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.2">
            <rect x="0.5" y="0.5" width="3.5" height="3.5" />
            <rect x="6"   y="0.5" width="3.5" height="3.5" />
            <rect x="0.5" y="6"   width="3.5" height="3.5" />
            <rect x="6"   y="6"   width="3.5" height="3.5" fill="currentColor" />
          </svg>
        </span>
      )}
      {row.hasRecentSpike && (
        <span className="process-heatmap-spike" title="Recent CPU spike">▲</span>
      )}
      <span className="process-heatmap-last">{last.toFixed(0)}%</span>
    </div>
  );
}

function HeatmapTooltip({ hover, scale, scaleLabel }: {
  hover: HoverCell;
  /** Scale fn that takes a raw sample + its ticks-back-from-now index,
   *  so Active mode can pick the right per-tick divisor. */
  scale: (v: number, ticksBack: number) => number;
  scaleLabel: "overall" | "active";
}) {
  const tx = Math.min(hover.clientX + 12, window.innerWidth - 260);
  const ty = Math.min(hover.clientY + 12, window.innerHeight - 80);
  const scaled = hover.cpu === null ? null : scale(hover.cpu, hover.ticksBack);
  const cpuLabel = scaled === null ? "no sample" : `${scaled.toFixed(1)}%`;
  const timeLabel = new Date(hover.time).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const scaleHint = scaleLabel === "overall" ? "overall" : "share of active";
  return (
    <div className="process-heatmap-tooltip" style={{ left: tx, top: ty }}>
      <div className="process-heatmap-tooltip-name">{hover.row.name}</div>
      <div className="process-heatmap-tooltip-line">
        <span className="process-heatmap-tooltip-label">CPU</span>
        <span className="process-heatmap-tooltip-value">
          {cpuLabel}
          <span className="process-heatmap-tooltip-scale-hint"> {scaleHint}</span>
        </span>
      </div>
      <div className="process-heatmap-tooltip-line">
        <span className="process-heatmap-tooltip-label">at</span>
        <span className="process-heatmap-tooltip-value">{timeLabel}</span>
      </div>
      <div className="process-heatmap-tooltip-line muted">PID {hover.row.pid}</div>
    </div>
  );
}

function TimeAxis({ sampleCount }: { sampleCount: number }) {
  // 5s interval is the default; at other intervals the labels are still
  // roughly right (off by a factor of 2 at 2s/10s), but we show "approximate"
  // sample-count marks so the axis stays legible without knowing the
  // interval. Future: thread the refresh interval through to exact labels.
  const labels: { offsetPct: number; text: string }[] = [];
  const steps = 5;
  for (let i = 0; i <= steps; i++) {
    const pct = (i / steps) * 100;
    const samplesBack = Math.round(((steps - i) / steps) * sampleCount);
    const secsBack = samplesBack * 5;
    const label = secsBack === 0 ? "now" : `-${formatSecs(secsBack)}`;
    labels.push({ offsetPct: pct, text: label });
  }
  return (
    <div className="process-heatmap-axis-inner">
      {labels.map((l) => (
        <span
          key={l.offsetPct}
          className="process-heatmap-axis-mark"
          style={{ left: `${l.offsetPct}%` }}
        >
          {l.text}
        </span>
      ))}
    </div>
  );
}

function formatSecs(secs: number): string {
  if (secs < 60) return `${secs}s`;
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  return s === 0 ? `${m}m` : `${m}m${s}s`;
}

function Legend() {
  return (
    <div className="process-heatmap-legend">
      <span className="process-heatmap-legend-label">0%</span>
      <div className="process-heatmap-legend-gradient" />
      <span className="process-heatmap-legend-label">100%</span>
    </div>
  );
}
