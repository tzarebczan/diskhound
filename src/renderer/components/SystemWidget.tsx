import { useCallback, useEffect, useLayoutEffect, useMemo, useState } from "preact/hooks";

import type {
  DiskIoProcessInfo,
  DiskIoSnapshot,
  DiskSpaceInfo,
  GeneralSettings,
  GpuSnapshot,
  ScanSnapshot,
  SystemMemorySnapshot,
} from "../../shared/contracts";
import { formatBytes, formatCount, relativeTime } from "../lib/format";
import { nativeApi } from "../nativeApi";

/**
 * DiskHound Monitor — always-on-top floating widget.
 *
 * Refresh cadences are deliberately staggered so a slow sampler
 * (PowerShell Get-Counter on a cold WDDM stack can take 1.5 s) never
 * blocks a faster one. Each cadence uses Promise.allSettled at the
 * call site so a single failing sampler degrades to a per-tile
 * empty state instead of taking the whole widget down.
 */
const DISK_REFRESH_MS = 10_000;
const MEMORY_REFRESH_MS = 4_000;
const DISK_IO_REFRESH_MS = 3_000;
const GPU_REFRESH_MS = 7_500;
/** How often to re-read settings — covers theme flips made in the
 *  main window (the widget runs in a separate renderer so the
 *  in-window SETTINGS_UPDATED_EVENT bus doesn't reach it). */
const SETTINGS_REFRESH_MS = 12_000;
/** Hide the "baseline" / "first sample…" placeholder text for this
 *  long after mount so the widget's first paint isn't hostile. */
const BASELINE_GRACE_MS = 4_000;

function resolveThemePreference(theme: GeneralSettings["theme"]): "dark" | "light" {
  if (theme === "light") return "light";
  if (theme === "system") {
    return window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
  }
  return "dark";
}

function pct(value: number | null | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "—%";
  return `${Math.round(Math.max(0, Math.min(100, value)))}%`;
}

function shortProcessName(name: string | undefined): string {
  if (!name) return "";
  return name.replace(/\.exe$/i, "");
}

function rootDrive(rootPath: string | null | undefined, drives: DiskSpaceInfo[]): DiskSpaceInfo | null {
  if (!rootPath) return null;
  const lower = rootPath.toLowerCase();
  return drives.find((d) => lower.startsWith(d.drive.toLowerCase())) ?? null;
}

/** Match the DriveCard pressure thresholds in the main app
 *  (DiskPicker.tsx) so a 92 %-full drive reads "critical" in both
 *  places. Was previously low/mid/high — now ok/warn/critical. */
function pressureClass(usedPercent: number | null | undefined): "ok" | "warn" | "critical" {
  if (typeof usedPercent !== "number" || !Number.isFinite(usedPercent)) return "ok";
  if (usedPercent > 90) return "critical";
  if (usedPercent > 75) return "warn";
  return "ok";
}

/** Categorise a disk-I/O process by direction. If reads dominate
 *  ≥5× over writes (or vice versa) we collapse to a single label;
 *  otherwise show both. Returns the label and the rate to display
 *  alongside it (always in bytes/s). */
function ioDirectionLabel(p: DiskIoProcessInfo): { prefix: string; rate: number } {
  const r = Math.max(0, p.readBytesPerSec);
  const w = Math.max(0, p.writeBytesPerSec);
  if (r === 0 && w === 0) return { prefix: "·", rate: 0 };
  if (w === 0 || r > w * 5) return { prefix: "r", rate: r };
  if (r === 0 || w > r * 5) return { prefix: "w", rate: w };
  return { prefix: "r+w", rate: p.totalBytesPerSec };
}

interface SamplerIssue {
  /** Stable key for React + dedupe. */
  source: "memory" | "diskIo" | "gpu";
  message: string;
}

export function SystemWidget() {
  const [drives, setDrives] = useState<DiskSpaceInfo[]>([]);
  const [scan, setScan] = useState<ScanSnapshot | null>(null);
  const [memory, setMemory] = useState<SystemMemorySnapshot | null>(null);
  const [diskIo, setDiskIo] = useState<DiskIoSnapshot | null>(null);
  const [gpu, setGpu] = useState<GpuSnapshot | null>(null);
  const [pinned, setPinned] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [hasFirstSample, setHasFirstSample] = useState(false);
  const [mountedAt] = useState<number>(() => Date.now());

  const gpuAvailable = nativeApi.platform === "win32";

  // ── Theme + body class ────────────────────────────────────
  // Body class added on mount, removed on unmount. Repeated calls
  // are no-ops via classList semantics so HMR re-mounts don't
  // double-class. useLayoutEffect rather than useEffect: the body
  // class controls the radial-gradient backdrop, and we'd rather
  // paint it on the first frame than after a flash of bare-body.
  useLayoutEffect(() => {
    document.body.classList.add("system-widget-body");
    return () => {
      document.body.classList.remove("system-widget-body");
    };
  }, []);

  const applyTheme = useCallback(async () => {
    const settings = await nativeApi.getSettings();
    if (!settings) return;
    const root = document.documentElement;
    const next = resolveThemePreference(settings.general.theme);
    root.classList.remove("dark", "light");
    root.classList.add(next);
    root.classList.toggle("colorblind", Boolean(settings.general.colorBlindMode));
  }, []);

  useEffect(() => {
    void applyTheme();
    const timer = window.setInterval(() => void applyTheme(), SETTINGS_REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [applyTheme]);

  // ── Sampler refresh helpers ───────────────────────────────
  const refreshDiskAndScan = useCallback(async () => {
    const [diskResult, scanResult] = await Promise.allSettled([
      nativeApi.getDiskSpace(),
      nativeApi.getCurrentSnapshot(),
    ]);
    if (diskResult.status === "fulfilled" && Array.isArray(diskResult.value)) {
      setDrives(diskResult.value);
    }
    if (scanResult.status === "fulfilled" && scanResult.value) {
      setScan(scanResult.value);
    }
  }, []);

  const refreshMemory = useCallback(async () => {
    const snap = await nativeApi.getMemorySnapshot();
    if (snap) setMemory(snap);
  }, []);

  const refreshDiskIo = useCallback(async () => {
    const snap = await nativeApi.getDiskIoSnapshot();
    if (snap) setDiskIo(snap);
  }, []);

  const refreshGpu = useCallback(async () => {
    if (!gpuAvailable) return;
    const snap = await nativeApi.getGpuSnapshot();
    if (snap) setGpu(snap);
  }, [gpuAvailable]);

  const refreshAll = useCallback(async () => {
    setRefreshing(true);
    try {
      await Promise.allSettled([
        refreshDiskAndScan(),
        refreshMemory(),
        refreshDiskIo(),
        refreshGpu(),
      ]);
    } finally {
      setRefreshing(false);
    }
  }, [refreshDiskAndScan, refreshDiskIo, refreshGpu, refreshMemory]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      // Pre-paint from main-process caches so the widget doesn't
      // flash "—%" placeholders before the first live samples
      // return. Each cache call resolves null on a cold boot, in
      // which case we just rely on refreshAll() below.
      const [cachedMemory, cachedDiskIo, cachedGpu] = await Promise.allSettled([
        nativeApi.getCachedMemorySnapshot(),
        nativeApi.getCachedDiskIoSnapshot(),
        gpuAvailable ? nativeApi.getCachedGpuSnapshot() : Promise.resolve(null),
      ]);
      if (cancelled) return;
      if (cachedMemory.status === "fulfilled" && cachedMemory.value) setMemory(cachedMemory.value);
      if (cachedDiskIo.status === "fulfilled" && cachedDiskIo.value) setDiskIo(cachedDiskIo.value);
      if (cachedGpu.status === "fulfilled" && cachedGpu.value) setGpu(cachedGpu.value);
      await refreshAll();
    })();
    const scanUnsub = nativeApi.onScanSnapshot((snapshot) => setScan(snapshot));
    const diskTimer = window.setInterval(() => void refreshDiskAndScan(), DISK_REFRESH_MS);
    const memoryTimer = window.setInterval(() => void refreshMemory(), MEMORY_REFRESH_MS);
    const diskIoTimer = window.setInterval(() => void refreshDiskIo(), DISK_IO_REFRESH_MS);
    const gpuTimer = gpuAvailable
      ? window.setInterval(() => void refreshGpu(), GPU_REFRESH_MS)
      : null;
    return () => {
      cancelled = true;
      scanUnsub();
      window.clearInterval(diskTimer);
      window.clearInterval(memoryTimer);
      window.clearInterval(diskIoTimer);
      if (gpuTimer !== null) window.clearInterval(gpuTimer);
    };
  }, [gpuAvailable, refreshAll, refreshDiskAndScan, refreshDiskIo, refreshGpu, refreshMemory]);

  // First-sample latch — flips true the moment ANY sampler comes
  // back. Drives the skeleton ↔ full-UI swap below.
  useEffect(() => {
    if (hasFirstSample) return;
    if (memory || diskIo || drives.length > 0 || (gpuAvailable && gpu)) {
      setHasFirstSample(true);
    }
  }, [hasFirstSample, memory, diskIo, drives.length, gpu, gpuAvailable]);

  // ── Keyboard ──────────────────────────────────────────────
  // Esc closes the widget; Ctrl/Cmd+R refreshes without reloading
  // the renderer (Electron's default F5/Ctrl+R reload would blow
  // away in-flight samples and is hostile in a frameless utility).
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        void nativeApi.closeSystemWidget();
        return;
      }
      const cmdR = (e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "r";
      if (cmdR) {
        e.preventDefault();
        void refreshAll();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [refreshAll]);

  // ── Derived metrics ───────────────────────────────────────
  const totalDisk = useMemo(() => {
    const totalBytes = drives.reduce((sum, d) => sum + d.totalBytes, 0);
    const usedBytes = drives.reduce((sum, d) => sum + d.usedBytes, 0);
    const freeBytes = drives.reduce((sum, d) => sum + d.freeBytes, 0);
    return {
      totalBytes,
      usedBytes,
      freeBytes,
      usedPercent: totalBytes > 0 ? (usedBytes / totalBytes) * 100 : 0,
    };
  }, [drives]);

  const activeDrive = rootDrive(scan?.rootPath, drives)
    ?? drives.slice().sort((a, b) => b.usedPercent - a.usedPercent)[0]
    ?? null;
  const diskPct = activeDrive?.usedPercent ?? totalDisk.usedPercent;
  const diskValue = activeDrive ? pct(activeDrive.usedPercent) : pct(totalDisk.usedPercent);
  const diskSub = activeDrive
    ? `${activeDrive.drive} · ${formatBytes(activeDrive.freeBytes)} free`
    : drives.length > 0
      ? `${formatBytes(totalDisk.freeBytes)} free`
      : "";

  const memoryPct = memory?.usedPercent ?? null;
  const cpuPercent = useMemo(() => {
    if (!memory) return null;
    const values = memory.processes
      .map((p) => p.cpuPercent)
      .filter((v): v is number => typeof v === "number" && Number.isFinite(v));
    if (values.length === 0) return null;
    return Math.min(100, values.reduce((sum, v) => sum + Math.max(0, v), 0));
  }, [memory]);
  const topCpu = memory?.processes
    .filter((p) => typeof p.cpuPercent === "number")
    .sort((a, b) => (b.cpuPercent ?? 0) - (a.cpuPercent ?? 0))[0];
  // Top CPU sub-line: "<name> 12%" — bare name doesn't tell you
  // anything about whether to act on it.
  const cpuSub = topCpu
    ? `${shortProcessName(topCpu.name)} ${pct(topCpu.cpuPercent)}`
    : memory ? `${memory.cpuCount} logical CPUs` : "";

  const diskRate = (diskIo?.totalReadBytesPerSec ?? 0) + (diskIo?.totalWriteBytesPerSec ?? 0);
  const topDisk = diskIo?.processes[0] ?? null;
  const topDiskDir = topDisk ? ioDirectionLabel(topDisk) : null;
  const diskBaselineGraceActive = !diskIo?.hasRateBaseline && (Date.now() - mountedAt < BASELINE_GRACE_MS);

  const gpuPercent = gpu && !gpu.unavailable
    ? Math.max(
        0,
        ...gpu.adapters.map((a) => a.utilizationPercent),
        ...gpu.processes.map((p) => p.utilizationPercent),
      )
    : null;
  const gpuMemUsed = gpu?.adapters.reduce((sum, a) => sum + a.dedicatedBytesUsed + a.sharedBytesUsed, 0) ?? 0;
  const topGpu = gpu?.processes[0] ?? null;
  const gpuSub = gpu?.unavailable
    ? "not available"
    : topGpu
      ? `${shortProcessName(topGpu.name)} ${pct(topGpu.utilizationPercent)}`
      : gpuMemUsed > 0
        ? `${formatBytes(gpuMemUsed)} VRAM`
        : "";

  // Sampler error stack — dedupe by source so a single PowerShell
  // failure doesn't show up three times.
  const samplerIssues: SamplerIssue[] = useMemo(() => {
    const out: SamplerIssue[] = [];
    if (memory?.errorMessage) out.push({ source: "memory", message: memory.errorMessage });
    if (diskIo?.errorMessage) out.push({ source: "diskIo", message: diskIo.errorMessage });
    if (gpuAvailable && gpu?.errorMessage) out.push({ source: "gpu", message: gpu.errorMessage });
    return out;
  }, [memory, diskIo, gpu, gpuAvailable]);

  const scanDrive = rootDrive(scan?.rootPath, drives);
  const scanPercent = scan?.status === "running" && scanDrive && scanDrive.usedBytes > 0
    ? Math.min(99, Math.max(0, Math.round((scan.bytesSeen / scanDrive.usedBytes) * 100)))
    : null;
  const scanTitle = scan?.status === "running"
    ? "Scan running"
    : scan?.status === "done"
      ? "Latest scan"
      : scan?.status === "error"
        ? "Scan failed"
        : "No active scan";
  const scanDetail = scan?.rootPath
    ? `${scan.rootPath}${scan.finishedAt ? ` · ${relativeTime(scan.finishedAt)}` : ""}`
    : "Pick a root in the main app to build disk history.";
  const scanRightLabel = scanPercent !== null
    ? `${scanPercent}%`
    : scan?.status === "done"
      ? "100%"
      : scan?.status === "error"
        ? "error"
        : "idle";
  // Scan bar fill: 0 when idle, scanPercent when running, 100 when
  // done/error. Idle was previously a phantom 8% stub which made
  // the widget look like something was always running.
  const scanFillPercent = scan?.status === "running"
    ? (scanPercent ?? 5)
    : scan?.status === "done" || scan?.status === "error"
      ? 100
      : 0;

  const setPinnedMode = async () => {
    const next = !pinned;
    setPinned(next);
    const actual = await nativeApi.setSystemWidgetPinned(next);
    setPinned(actual);
  };

  // Build the hero tile list dynamically. GPU is hidden on
  // non-Windows because the sampler genuinely doesn't work there
  // (Windows-only WDDM perf counters); a permanent "n/a" tile is
  // wasted real estate. Hero grid auto-adjusts to N columns.
  const heroTileCount = gpuAvailable ? 4 : 3;

  // ── Skeleton state ────────────────────────────────────────
  if (!hasFirstSample) {
    return (
      <div className="system-widget-shell">
        <Titlebar
          updatedLabel="sampling…"
          refreshing={true}
          pinned={pinned}
          onRefresh={() => void refreshAll()}
          onTogglePin={() => void setPinnedMode()}
        />
        <main className="system-widget-content system-widget-content-loading">
          <div className="system-widget-skeleton">
            <div className="system-widget-skeleton-pulse" aria-hidden="true" />
            <span>Sampling system…</span>
          </div>
        </main>
      </div>
    );
  }

  return (
    <div className="system-widget-shell">
      <Titlebar
        updatedLabel={memory ? `updated ${relativeTime(memory.sampledAt)}` : "—"}
        refreshing={refreshing}
        pinned={pinned}
        onRefresh={() => void refreshAll()}
        onTogglePin={() => void setPinnedMode()}
      />

      <main className="system-widget-content">
        <section className={`system-widget-tiles tiles-${heroTileCount}`}>
          <StatTile
            kicker="Disk"
            value={diskValue}
            sub={diskSub}
            percent={diskPct}
            accent="amber"
          />
          <StatTile
            kicker="Memory"
            value={pct(memoryPct)}
            sub={memory ? `${formatBytes(memory.usedBytes)} / ${formatBytes(memory.totalBytes)}` : ""}
            percent={memoryPct ?? 0}
            accent="blue"
          />
          <StatTile
            kicker="CPU"
            value={pct(cpuPercent)}
            sub={cpuSub}
            percent={cpuPercent ?? 0}
            accent="green"
          />
          {gpuAvailable && (
            <StatTile
              kicker="GPU"
              value={gpu?.unavailable ? "n/a" : pct(gpuPercent)}
              sub={gpuSub}
              percent={gpu?.unavailable ? 0 : (gpuPercent ?? 0)}
              accent="teal"
              dimmed={gpu?.unavailable}
            />
          )}
        </section>

        <section className="system-widget-section">
          <SectionHead label="Disk I/O" value={`${formatBytes(diskRate)}/s`} />
          <div className="system-widget-io-bars">
            <FlowBar label="read"  value={diskIo?.totalReadBytesPerSec ?? 0}  total={Math.max(1, diskRate)} tone="blue" />
            <FlowBar label="write" value={diskIo?.totalWriteBytesPerSec ?? 0} total={Math.max(1, diskRate)} tone="amber" />
          </div>
          {topDisk && topDiskDir ? (
            <div className="system-widget-process-line">
              <span>
                <em>{topDiskDir.prefix}</em> {shortProcessName(topDisk.name)}
              </span>
              <span>{formatBytes(topDiskDir.rate)}/s</span>
            </div>
          ) : diskIo?.unavailable ? (
            <div className="system-widget-process-line muted">
              <span>I/O sampler unavailable</span>
            </div>
          ) : !diskBaselineGraceActive ? (
            <div className="system-widget-process-line muted">
              <span>{diskIo?.hasRateBaseline ? "idle" : "first sample…"}</span>
            </div>
          ) : null}
        </section>

        <section className={`system-widget-section system-widget-scan ${scan?.status ?? "idle"}`}>
          <SectionHead label={scanTitle} value={scanRightLabel} />
          <div className="system-widget-scan-path" title={scanDetail}>{scanDetail}</div>
          {scan && scan.status !== "idle" && (
            <div className="system-widget-scan-stats">
              <span>{formatBytes(scan.bytesSeen)}</span>
              <span>{formatCount(scan.filesVisited)} files</span>
              <span>{formatCount(scan.directoriesVisited)} dirs</span>
            </div>
          )}
          <div className="system-widget-scan-track" aria-hidden="true">
            <div
              className="system-widget-scan-fill"
              style={{ width: `${scanFillPercent}%` }}
            />
          </div>
        </section>

        <section className="system-widget-section">
          <SectionHead label="Drives" value={`${formatBytes(totalDisk.freeBytes)} free`} />
          <div className="system-widget-drive-list">
            {drives.slice(0, 4).map((drive) => {
              const cls = pressureClass(drive.usedPercent);
              return (
                <div className="system-widget-drive-row" key={drive.drive}>
                  <div className="system-widget-drive-label">
                    <span>{drive.drive}</span>
                    <span>{formatBytes(drive.freeBytes)} free</span>
                  </div>
                  <div className="system-widget-drive-track">
                    <div
                      className={`system-widget-drive-fill ${cls}`}
                      style={{ width: `${Math.max(2, Math.min(100, drive.usedPercent))}%` }}
                    />
                  </div>
                </div>
              );
            })}
            {drives.length === 0 && <div className="system-widget-empty">Waiting for drive telemetry.</div>}
            {drives.length > 4 && (
              <button
                type="button"
                className="system-widget-drive-more"
                onClick={() => void nativeApi.focusMainWindow()}
                title="Open the main app to see all drives"
              >
                + {drives.length - 4} more {drives.length - 4 === 1 ? "drive" : "drives"} →
              </button>
            )}
          </div>
        </section>

        {samplerIssues.length > 0 && (
          <section className="system-widget-warnings">
            {samplerIssues.map((issue) => (
              <div key={issue.source} className="system-widget-warning" title={issue.message}>
                <strong>{issue.source}:</strong> {issue.message}
              </div>
            ))}
          </section>
        )}
      </main>
    </div>
  );
}

// ── Sub-components ───────────────────────────────────────────

function Titlebar(props: {
  updatedLabel: string;
  refreshing: boolean;
  pinned: boolean;
  onRefresh: () => void;
  onTogglePin: () => void;
}) {
  const { updatedLabel, refreshing, pinned, onRefresh, onTogglePin } = props;
  return (
    <header className="system-widget-titlebar">
      <DragGrip />
      <div className="system-widget-brand">
        <BrandMark />
        <div className="system-widget-brand-text">
          <div className="system-widget-title">DiskHound Monitor</div>
          <div className="system-widget-subtitle">
            <span className={`system-widget-live-dot ${refreshing ? "refreshing" : ""}`} aria-hidden="true" />
            {updatedLabel}
          </div>
        </div>
      </div>
      <div className="system-widget-actions">
        <button
          type="button"
          className={`system-widget-icon-btn ${refreshing ? "refreshing" : ""}`}
          title="Refresh (Ctrl+R)"
          onClick={onRefresh}
        >
          <svg width="13" height="13" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 3.5V1h-2.5" />
            <path d="M11.2 4A5 5 0 1 0 12 8" />
          </svg>
        </button>
        <button
          type="button"
          className={`system-widget-icon-btn ${pinned ? "active" : ""}`}
          title={pinned ? "Unpin from top" : "Keep on top"}
          aria-pressed={pinned}
          onClick={onTogglePin}
        >
          <PinIcon active={pinned} />
        </button>
        <span className="system-widget-actions-divider" aria-hidden="true" />
        <button
          type="button"
          className="system-widget-icon-btn"
          title="Open main window"
          onClick={() => void nativeApi.focusMainWindow()}
        >
          <svg width="13" height="13" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.45" strokeLinejoin="round">
            <rect x="2" y="2.5" width="10" height="8.8" rx="1.4" />
            <path d="M5 12h4" strokeLinecap="round" />
          </svg>
        </button>
        <button
          type="button"
          className="system-widget-icon-btn close"
          title="Close (Esc)"
          onClick={() => void nativeApi.closeSystemWidget()}
        >
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
            <path d="M3 3l6 6M9 3 3 9" />
          </svg>
        </button>
      </div>
    </header>
  );
}

/** Same 16×16 stacked-tile mark used in the main app header
 *  ([App.tsx, line ~882](src/renderer/App.tsx)). Anchors widget
 *  identity to DiskHound rather than feeling like a separate
 *  product. */
function BrandMark() {
  return (
    <svg className="system-widget-brand-mark" width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <rect x="1" y="1" width="14" height="14" rx="2" stroke="currentColor" strokeWidth="1.5" />
      <rect x="4" y="4" width="4" height="4" fill="currentColor" opacity="0.85" />
      <rect x="9" y="4" width="3" height="8" fill="currentColor" opacity="0.55" />
      <rect x="4" y="9" width="4" height="3" fill="currentColor" opacity="0.35" />
    </svg>
  );
}

/** 2-column dot grip — the de-facto standard "this is draggable"
 *  affordance on frameless utility windows (iStat, Stats, Loop,
 *  Rectangle, every menubar widget on macOS). Pure decoration,
 *  zero-width interactive (drag is the whole titlebar). */
function DragGrip() {
  return (
    <svg className="system-widget-grip" width="8" height="14" viewBox="0 0 8 14" fill="currentColor" aria-hidden="true">
      <circle cx="2" cy="3"  r="1" />
      <circle cx="6" cy="3"  r="1" />
      <circle cx="2" cy="7"  r="1" />
      <circle cx="6" cy="7"  r="1" />
      <circle cx="2" cy="11" r="1" />
      <circle cx="6" cy="11" r="1" />
    </svg>
  );
}

/** Real thumbtack glyph viewed from the front: head bar on top,
 *  trapezoidal body, vertical shaft. When `active` (pinned) the
 *  body fills with currentColor so the state reads at a glance —
 *  prior svg used the same outline-only path either way and the
 *  pinned/unpinned states were indistinguishable past arm's
 *  length. */
function PinIcon({ active }: { active: boolean }) {
  return (
    <svg width="13" height="13" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.45" strokeLinecap="round" strokeLinejoin="round">
      {/* head bar */}
      <path d="M4.2 2h5.6" />
      {/* trapezoidal body */}
      <path
        d="M4.6 2v3.4L3.1 7.1h7.8L9.4 5.4V2"
        fill={active ? "currentColor" : "none"}
      />
      {/* shaft */}
      <path d="M7 7.1v5.4" />
    </svg>
  );
}

function SectionHead({ label, value }: { label: string; value: string }) {
  return (
    <div className="system-widget-section-head">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function StatTile({ kicker, value, sub, percent, accent, dimmed = false }: {
  kicker: string;
  value: string;
  sub: string;
  percent: number;
  accent: "amber" | "blue" | "green" | "teal";
  dimmed?: boolean;
}) {
  const clamped = Math.max(0, Math.min(100, Number.isFinite(percent) ? percent : 0));
  return (
    <div className={`system-widget-stat ${accent} ${dimmed ? "dimmed" : ""}`}>
      <div className="system-widget-stat-kicker">{kicker}</div>
      <div className="system-widget-stat-value">{value}</div>
      <div className="system-widget-stat-track" aria-hidden="true">
        <div className="system-widget-stat-fill" style={{ width: `${clamped}%` }} />
      </div>
      {/* &nbsp; reserves the line so tiles with an empty sub still
       *  align vertically with their neighbours — otherwise a tile
       *  with a process name and one without have different heights. */}
      <div className="system-widget-stat-sub" title={sub}>{sub || " "}</div>
    </div>
  );
}

function FlowBar({ label, value, total, tone }: {
  label: string;
  value: number;
  total: number;
  tone: "blue" | "amber";
}) {
  const width = total > 0 ? Math.max(2, Math.min(100, (value / total) * 100)) : 0;
  return (
    <div className="system-widget-flow-row">
      <span>{label}</span>
      <div className="system-widget-flow-track">
        <div className={`system-widget-flow-fill ${tone}`} style={{ width: `${width}%` }} />
      </div>
      <strong>{formatBytes(value)}/s</strong>
    </div>
  );
}
