import { useCallback, useEffect, useLayoutEffect, useMemo, useState } from "preact/hooks";

import type {
  AppSettings,
  AppView,
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
/** Hide the "first sample…" placeholder text for this long after
 *  mount so the widget's first paint isn't hostile. */
const BASELINE_GRACE_MS = 4_000;
/** Show a stale-data pill at the top when the memory sample is
 *  older than this. The slowest live sampler (disk/scan, 10 s)
 *  drives the threshold — anything older than ~3× that means
 *  the widget has lost the heartbeat. */
const STALE_THRESHOLD_MS = 30_000;
/** Sparkline ring-buffer cap. 20 points × per-metric cadence
 *  gives 60-200 s of trend per tile, which is the right horizon
 *  for "is this getting worse right now?" — long enough to read
 *  the slope, short enough that the line stays current. */
const HISTORY_CAP = 20;

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
 *  (DiskPicker.tsx) so a 92 %-full drive reads "critical" in
 *  both places. */
function pressureClass(usedPercent: number | null | undefined): "ok" | "warn" | "critical" {
  if (typeof usedPercent !== "number" || !Number.isFinite(usedPercent)) return "ok";
  if (usedPercent > 90) return "critical";
  if (usedPercent > 75) return "warn";
  return "ok";
}

/** Map drive pressure → tile accent color. Critical (>90 %)
 *  reads RED in the hero tile, matching the per-drive bar
 *  below it. Previously the DISK tile was hard-coded to amber
 *  regardless of the actual percentage, which created the
 *  awkward "92 % shown in amber while the same drive's bar
 *  below shows red" inconsistency. */
function diskPressureAccent(usedPercent: number | null | undefined): TileAccent {
  switch (pressureClass(usedPercent)) {
    case "critical": return "red";
    case "warn":     return "amber";
    default:         return "green";
  }
}

/** Categorise a disk-I/O process by direction. If reads dominate
 *  ≥5× over writes (or vice versa) we collapse to a single
 *  label; otherwise show both. */
function ioDirectionLabel(p: DiskIoProcessInfo): { prefix: string; rate: number } {
  const r = Math.max(0, p.readBytesPerSec);
  const w = Math.max(0, p.writeBytesPerSec);
  if (r === 0 && w === 0) return { prefix: "·", rate: 0 };
  if (w === 0 || r > w * 5) return { prefix: "r", rate: r };
  if (r === 0 || w > r * 5) return { prefix: "w", rate: w };
  return { prefix: "r+w", rate: p.totalBytesPerSec };
}

function formatStaleAge(seconds: number): string {
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    const remSec = seconds % 60;
    return remSec > 0 ? `${minutes}m ${remSec}s ago` : `${minutes}m ago`;
  }
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m ago`;
}

type TileAccent = "amber" | "blue" | "green" | "teal" | "red";

interface SamplerIssue {
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
  const [hasFirstSample, setHasFirstSample] = useState(false);
  const [mountedAt] = useState<number>(() => Date.now());
  // Re-evaluated periodically so the stale pill ages even
  // between sampler ticks. Cheap to update — the main render
  // is already gated on snapshot changes for the data tiles.
  const [now, setNow] = useState<number>(() => Date.now());

  // Per-metric ring buffers for the sparklines. Each metric
  // appends its latest 0-100 value when its sampler returns;
  // sparkline component reads tail-N for the trace.
  const [diskHistory, setDiskHistory] = useState<number[]>([]);
  const [memoryHistory, setMemoryHistory] = useState<number[]>([]);
  const [cpuHistory, setCpuHistory] = useState<number[]>([]);
  const [gpuHistory, setGpuHistory] = useState<number[]>([]);

  const gpuAvailable = nativeApi.platform === "win32";

  // ── Theme + body class ────────────────────────────────────
  useLayoutEffect(() => {
    document.body.classList.add("system-widget-body");
    return () => {
      document.body.classList.remove("system-widget-body");
    };
  }, []);

  const applySettingsToTheme = useCallback((settings: AppSettings) => {
    const root = document.documentElement;
    const next = resolveThemePreference(settings.general.theme);
    root.classList.remove("dark", "light");
    root.classList.add(next);
    root.classList.toggle("colorblind", Boolean(settings.general.colorBlindMode));
  }, []);

  useEffect(() => {
    void nativeApi.getSettings().then((settings) => {
      if (settings) applySettingsToTheme(settings);
    });
    return nativeApi.onSettingsUpdated((settings) => {
      applySettingsToTheme(settings);
    });
  }, [applySettingsToTheme]);

  // Periodic `now` refresh purely so the stale-pill age ticks
  // between sampler updates. 5 s cadence is fine — staleness
  // accumulates slowly by definition. No re-render cost when the
  // pill is hidden (it's gated on isStale below).
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 5_000);
    return () => window.clearInterval(id);
  }, []);

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
    await Promise.allSettled([
      refreshDiskAndScan(),
      refreshMemory(),
      refreshDiskIo(),
      refreshGpu(),
    ]);
  }, [refreshDiskAndScan, refreshDiskIo, refreshGpu, refreshMemory]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
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

  useEffect(() => {
    if (hasFirstSample) return;
    if (memory || diskIo || drives.length > 0 || (gpuAvailable && gpu)) {
      setHasFirstSample(true);
    }
  }, [hasFirstSample, memory, diskIo, drives.length, gpu, gpuAvailable]);

  // ── Keyboard ──────────────────────────────────────────────
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
  const cpuSub = topCpu
    ? `${shortProcessName(topCpu.name)} ${pct(topCpu.cpuPercent)}`
    : memory ? `${memory.cpuCount} logical CPUs` : "";

  const diskRate = (diskIo?.totalReadBytesPerSec ?? 0) + (diskIo?.totalWriteBytesPerSec ?? 0);
  const topDisk = diskIo?.processes[0] ?? null;
  const topDiskDir = topDisk ? ioDirectionLabel(topDisk) : null;
  const diskBaselineGraceActive = !diskIo?.hasRateBaseline && (now - mountedAt < BASELINE_GRACE_MS);

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

  // ── Sparkline ring-buffer updates ─────────────────────────
  // Each metric pushes when its underlying snapshot changes.
  // Gating on `drives` / `memory` / `diskIo` / `gpu` (rather
  // than on the derived percent) keeps us from double-pushing
  // the same value across renders that don't carry new data.
  useEffect(() => {
    if (drives.length === 0) return;
    const value = activeDrive?.usedPercent ?? totalDisk.usedPercent;
    if (typeof value === "number" && Number.isFinite(value)) {
      setDiskHistory((h) => [...h.slice(-(HISTORY_CAP - 1)), value]);
    }
    // activeDrive depends on drives + scan?.rootPath; both changing
    // legitimately moves the "active" drive, which we want to record.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [drives, scan?.rootPath]);
  useEffect(() => {
    if (!memory) return;
    setMemoryHistory((h) => [...h.slice(-(HISTORY_CAP - 1)), memory.usedPercent]);
    const cpu = memory.processes
      .map((p) => p.cpuPercent)
      .filter((v): v is number => typeof v === "number" && Number.isFinite(v));
    if (cpu.length > 0) {
      const total = Math.min(100, cpu.reduce((sum, v) => sum + Math.max(0, v), 0));
      setCpuHistory((h) => [...h.slice(-(HISTORY_CAP - 1)), total]);
    }
  }, [memory]);
  useEffect(() => {
    if (!gpu || gpu.unavailable) return;
    const value = Math.max(
      0,
      ...gpu.adapters.map((a) => a.utilizationPercent),
      ...gpu.processes.map((p) => p.utilizationPercent),
    );
    setGpuHistory((h) => [...h.slice(-(HISTORY_CAP - 1)), value]);
  }, [gpu]);

  // ── Stale callout ─────────────────────────────────────────
  // Memory is the fastest sampler (4 s cadence) and the one
  // that drives the rest of the widget's "alive" feel — if its
  // sampledAt drifts >30 s we tell the user. Below the
  // threshold the pill is hidden entirely so normal operation
  // is silent (per the "don't add noise that's always true"
  // principle from the previous round of polish).
  const memoryAge = memory ? Math.max(0, Math.round((now - memory.sampledAt) / 1000)) : 0;
  const isStale = memory != null && (now - memory.sampledAt) > STALE_THRESHOLD_MS;

  // ── Sampler error stack ───────────────────────────────────
  const samplerIssues: SamplerIssue[] = useMemo(() => {
    const out: SamplerIssue[] = [];
    if (memory?.errorMessage) out.push({ source: "memory", message: memory.errorMessage });
    if (diskIo?.errorMessage) out.push({ source: "diskIo", message: diskIo.errorMessage });
    if (gpuAvailable && gpu?.errorMessage) out.push({ source: "gpu", message: gpu.errorMessage });
    return out;
  }, [memory, diskIo, gpu, gpuAvailable]);

  // ── Scan section ──────────────────────────────────────────
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

  // ── Click-through helper ──────────────────────────────────
  // Single entry point — the widget brings the main window
  // forward AND tells its renderer which tab to switch to. The
  // main process IPC handler does both atomically (focus +
  // emit-navigate); App.tsx subscribes once on mount.
  const navigate = useCallback((view: AppView, scanRoot?: string) => {
    void nativeApi.focusMainWithView({ view, ...(scanRoot ? { scanRoot } : {}) });
  }, []);

  const heroTileCount = gpuAvailable ? 4 : 3;

  // ── Skeleton state ────────────────────────────────────────
  if (!hasFirstSample) {
    return (
      <div className="system-widget-shell">
        <Titlebar
          pinned={pinned}
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
        pinned={pinned}
        onTogglePin={() => void setPinnedMode()}
      />

      <main className="system-widget-content">
        {isStale && (
          <div className="system-widget-stale" title={`Last sample at ${new Date(memory!.sampledAt).toLocaleTimeString()}`}>
            <span className="system-widget-stale-dot" aria-hidden="true" />
            stale · {formatStaleAge(memoryAge)}
          </div>
        )}

        <section className={`system-widget-tiles tiles-${heroTileCount}`}>
          <StatTile
            kicker="Disk"
            value={diskValue}
            sub={diskSub}
            percent={diskPct}
            accent={diskPressureAccent(diskPct)}
            history={diskHistory}
            onClick={() => navigate("overview", activeDrive?.drive)}
            ariaLabel={`Disk ${diskValue} used. Click to open the main app's Overview.`}
          />
          <StatTile
            kicker="Memory"
            value={pct(memoryPct)}
            sub={memory ? `${formatBytes(memory.usedBytes)} / ${formatBytes(memory.totalBytes)}` : ""}
            percent={memoryPct ?? 0}
            accent="blue"
            history={memoryHistory}
            onClick={() => navigate("memory")}
            ariaLabel={`Memory ${pct(memoryPct)} used. Click to open the Processes tab.`}
          />
          <StatTile
            kicker="CPU"
            value={pct(cpuPercent)}
            sub={cpuSub}
            percent={cpuPercent ?? 0}
            accent="green"
            history={cpuHistory}
            onClick={() => navigate("memory")}
            ariaLabel={`CPU ${pct(cpuPercent)} active. Click to open the Processes tab.`}
          />
          {gpuAvailable && (
            <StatTile
              kicker="GPU"
              value={gpu?.unavailable ? "n/a" : pct(gpuPercent)}
              sub={gpuSub}
              percent={gpu?.unavailable ? 0 : (gpuPercent ?? 0)}
              accent="teal"
              dimmed={gpu?.unavailable}
              history={gpuHistory}
              onClick={() => navigate("memory")}
              ariaLabel={`GPU ${gpu?.unavailable ? "not available" : pct(gpuPercent)}. Click to open the Processes tab.`}
            />
          )}
        </section>

        <ClickableSection
          onClick={() => navigate("diskIo")}
          ariaLabel="Open the Disk I/O tab in the main app"
        >
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
        </ClickableSection>

        <ClickableSection
          onClick={() => navigate("changes")}
          ariaLabel="Open the Changes tab in the main app"
          className={`system-widget-scan ${scan?.status ?? "idle"}`}
        >
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
        </ClickableSection>

        <section className="system-widget-section">
          <SectionHead label="Drives" value={`${formatBytes(totalDisk.freeBytes)} free`} />
          <div className="system-widget-drive-list">
            {drives.slice(0, 4).map((drive) => {
              const cls = pressureClass(drive.usedPercent);
              return (
                <button
                  type="button"
                  className="system-widget-drive-row"
                  key={drive.drive}
                  onClick={() => navigate("overview", drive.drive)}
                  title={`${drive.drive} ${formatBytes(drive.freeBytes)} free of ${formatBytes(drive.totalBytes)} · ${pct(drive.usedPercent)} used · click to focus in main`}
                >
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
                </button>
              );
            })}
            {drives.length === 0 && <div className="system-widget-empty">Waiting for drive telemetry.</div>}
            {drives.length > 4 && (
              <button
                type="button"
                className="system-widget-drive-more"
                onClick={() => navigate("overview")}
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
  pinned: boolean;
  onTogglePin: () => void;
}) {
  const { pinned, onTogglePin } = props;
  return (
    <header className="system-widget-titlebar">
      <DragGrip />
      <div className="system-widget-brand">
        <BrandMark />
        <div className="system-widget-title">DiskHound Monitor</div>
      </div>
      <div className="system-widget-actions">
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

function PinIcon({ active }: { active: boolean }) {
  return (
    <svg width="13" height="13" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.45" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4.2 2h5.6" />
      <path
        d="M4.6 2v3.4L3.1 7.1h7.8L9.4 5.4V2"
        fill={active ? "currentColor" : "none"}
      />
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

/**
 * Section card whose entire surface is a click-through into a
 * specific main-app tab. Renders as a `<button>` so it's
 * keyboard-focusable and announces correctly to screen readers.
 * Hover state lifts the background a touch and reveals a small
 * "↗" affordance in the corner. Section content is passed as
 * children so each call site can keep its bespoke layout.
 */
function ClickableSection(props: {
  onClick: () => void;
  ariaLabel: string;
  className?: string;
  children: preact.ComponentChildren;
}) {
  const { onClick, ariaLabel, className, children } = props;
  return (
    <button
      type="button"
      className={`system-widget-section system-widget-section-clickable ${className ?? ""}`}
      onClick={onClick}
      aria-label={ariaLabel}
    >
      {children}
    </button>
  );
}

function StatTile(props: {
  kicker: string;
  value: string;
  sub: string;
  percent: number;
  accent: TileAccent;
  dimmed?: boolean;
  history: number[];
  onClick: () => void;
  ariaLabel: string;
}) {
  const { kicker, value, sub, percent, accent, dimmed = false, history, onClick, ariaLabel } = props;
  const clamped = Math.max(0, Math.min(100, Number.isFinite(percent) ? percent : 0));
  return (
    <button
      type="button"
      className={`system-widget-stat ${accent} ${dimmed ? "dimmed" : ""}`}
      onClick={onClick}
      aria-label={ariaLabel}
    >
      <div className="system-widget-stat-kicker">{kicker}</div>
      <div className="system-widget-stat-value-row">
        <span className="system-widget-stat-value">{value}</span>
        <Sparkline values={history} accent={accent} />
      </div>
      <div className="system-widget-stat-track" aria-hidden="true">
        <div className="system-widget-stat-fill" style={{ width: `${clamped}%` }} />
      </div>
      <div className="system-widget-stat-sub" title={sub}>{sub || " "}</div>
    </button>
  );
}

/**
 * Inline SVG sparkline. 60 × 16 px, fixed scale 0-100 (every
 * metric is a percent so we don't need to compute min/max — the
 * absolute "where am I in 0-100?" is the right framing). Returns
 * null below 2 points because a single dot reads as noise.
 *
 * Stroke uses the tile's accent color via `currentColor`. No
 * fill — a flat polyline is enough; an area fill would compete
 * with the progress bar below it for the "how full?" signal.
 */
function Sparkline({ values, accent }: { values: number[]; accent: TileAccent }) {
  if (values.length < 2) {
    // Reserve the space so tiles with and without history don't
    // bounce in width as samples accumulate.
    return <span className="system-widget-sparkline system-widget-sparkline-empty" aria-hidden="true" />;
  }
  const W = 60;
  const H = 16;
  const max = 100;
  const stepX = W / (values.length - 1);
  const points = values
    .map((v, i) => {
      const x = i * stepX;
      const clamped = Math.max(0, Math.min(max, v));
      // 1 px inset top + bottom so the stroke doesn't get clipped
      // at the edges.
      const y = H - 1 - (clamped / max) * (H - 2);
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
  return (
    <svg
      className={`system-widget-sparkline ${accent}`}
      width={W}
      height={H}
      viewBox={`0 0 ${W} ${H}`}
      aria-hidden="true"
    >
      <polyline points={points} fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
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
