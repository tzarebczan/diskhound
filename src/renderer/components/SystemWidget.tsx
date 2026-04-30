import { useCallback, useEffect, useLayoutEffect, useMemo, useState } from "preact/hooks";

import type {
  AppSettings,
  DiskIoProcessInfo,
  DiskIoSnapshot,
  DiskSpaceInfo,
  GeneralSettings,
  GpuProcessInfo,
  GpuSnapshot,
  ProcessInfo,
  ScanSnapshot,
  SystemMemorySnapshot,
} from "../../shared/contracts";
import { formatBytes, formatCount, relativeTime } from "../lib/format";
import { nativeApi } from "../nativeApi";

/**
 * DiskHound Monitor — always-on-top floating widget.
 *
 * Standalone: tile clicks expand inline detail panels in the
 * widget (top-N processes for MEM/CPU/GPU). The DRIVES section
 * is the natural detail for the DISK tile so DISK stays passive.
 * The only navigate-to-main affordance is the explicit "View
 * changes →" button in the SCAN section after a scan completes
 * — the rest of the widget never steals the user's main-window
 * focus.
 *
 * Refresh cadences are deliberately staggered so a slow sampler
 * (PowerShell Get-Counter on a cold WDDM stack can take 1.5 s)
 * never blocks a faster one. Each cadence uses
 * Promise.allSettled at the call site so a single failing
 * sampler degrades to a per-tile empty state instead of taking
 * the whole widget down.
 */
const DISK_REFRESH_MS = 10_000;
const MEMORY_REFRESH_MS = 4_000;
const DISK_IO_REFRESH_MS = 3_000;
const GPU_REFRESH_MS = 7_500;
const BASELINE_GRACE_MS = 4_000;
const STALE_THRESHOLD_MS = 30_000;
const HISTORY_CAP = 20;
const DETAIL_TOP_N = 5;

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

function pressureClass(usedPercent: number | null | undefined): "ok" | "warn" | "critical" {
  if (typeof usedPercent !== "number" || !Number.isFinite(usedPercent)) return "ok";
  if (usedPercent > 90) return "critical";
  if (usedPercent > 75) return "warn";
  return "ok";
}

function diskPressureAccent(usedPercent: number | null | undefined): TileAccent {
  switch (pressureClass(usedPercent)) {
    case "critical": return "red";
    case "warn":     return "amber";
    default:         return "green";
  }
}

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

/** Compact elapsed-time formatter for the running-scan stats line.
 *  Drops leading zeroes — a 12 s scan reads "12s", a 2-minute
 *  scan "2m 14s", an hour-plus scan "1h 03m". */
function formatScanElapsed(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    const remSec = seconds % 60;
    return `${minutes}m ${remSec.toString().padStart(2, "0")}s`;
  }
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${(minutes % 60).toString().padStart(2, "0")}m`;
}

type TileAccent = "amber" | "blue" | "green" | "teal" | "red";
type DetailType = "memory" | "cpu" | "gpu";

interface SamplerIssue {
  source: "memory" | "diskIo" | "gpu";
  message: string;
}

interface DetailRow {
  key: string | number;
  name: string;
  value: string;
  /** 0–100 — drives the per-row mini-bar's relative width. */
  pct: number;
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
  const [now, setNow] = useState<number>(() => Date.now());

  // Inline detail panel — null when collapsed. Click a hero
  // tile to open its detail; click the same tile again (or the
  // panel's close button) to collapse. DISK has no detail
  // because the DRIVES section below the tiles is already its
  // natural expansion — duplicating it as a click-in panel
  // would just repeat data.
  const [activeDetail, setActiveDetail] = useState<DetailType | null>(null);

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
        // First Esc collapses an open detail panel; second Esc
        // closes the widget. Less surprising than blowing the
        // window away mid-investigation.
        if (activeDetail) {
          setActiveDetail(null);
          return;
        }
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
  }, [activeDetail, refreshAll]);

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
  useEffect(() => {
    if (drives.length === 0) return;
    const value = activeDrive?.usedPercent ?? totalDisk.usedPercent;
    if (typeof value === "number" && Number.isFinite(value)) {
      setDiskHistory((h) => [...h.slice(-(HISTORY_CAP - 1)), value]);
    }
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

  // ── Detail-panel data ─────────────────────────────────────
  // Computed eagerly so `activeDetail` toggles produce no
  // visible delay. Each accessor returns top-N rows for its
  // category, sorted by the relevant metric.
  const memoryDetail = useMemo<DetailRow[]>(() => {
    if (!memory) return [];
    const top = memory.processes
      .slice()
      .sort((a, b) => b.memoryBytes - a.memoryBytes)
      .slice(0, DETAIL_TOP_N);
    const max = top[0]?.memoryBytes ?? 1;
    return top.map((p: ProcessInfo) => ({
      key: p.pid,
      name: shortProcessName(p.name),
      value: formatBytes(p.memoryBytes),
      pct: max > 0 ? (p.memoryBytes / max) * 100 : 0,
    }));
  }, [memory]);

  const cpuDetail = useMemo<DetailRow[]>(() => {
    if (!memory) return [];
    const top = memory.processes
      .filter((p) => typeof p.cpuPercent === "number" && (p.cpuPercent ?? 0) > 0)
      .slice()
      .sort((a, b) => (b.cpuPercent ?? 0) - (a.cpuPercent ?? 0))
      .slice(0, DETAIL_TOP_N);
    const max = top[0]?.cpuPercent ?? 1;
    return top.map((p: ProcessInfo) => ({
      key: p.pid,
      name: shortProcessName(p.name),
      value: pct(p.cpuPercent),
      pct: max > 0 ? ((p.cpuPercent ?? 0) / max) * 100 : 0,
    }));
  }, [memory]);

  const gpuDetail = useMemo<DetailRow[]>(() => {
    if (!gpu || gpu.unavailable) return [];
    const top = gpu.processes
      .slice()
      .sort((a, b) => b.utilizationPercent - a.utilizationPercent)
      .slice(0, DETAIL_TOP_N);
    const max = top[0]?.utilizationPercent ?? 1;
    return top.map((p: GpuProcessInfo) => ({
      key: p.pid,
      name: shortProcessName(p.name),
      value: pct(p.utilizationPercent),
      pct: max > 0 ? (p.utilizationPercent / max) * 100 : 0,
    }));
  }, [gpu]);

  // ── Stale callout ─────────────────────────────────────────
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
  // Live-elapsed for running scans. Re-evaluated on each `now`
  // tick (every 5 s) so the timer doesn't freeze between
  // scan-snapshot pushes.
  const scanElapsedSec = scan?.status === "running" && scan.startedAt
    ? Math.max(0, Math.floor((now - scan.startedAt) / 1000))
    : null;

  const setPinnedMode = async () => {
    const next = !pinned;
    setPinned(next);
    const actual = await nativeApi.setSystemWidgetPinned(next);
    setPinned(actual);
  };

  const toggleDetail = useCallback((type: DetailType) => {
    setActiveDetail((prev) => (prev === type ? null : type));
  }, []);

  const heroTileCount = gpuAvailable ? 4 : 3;

  // ── Skeleton state ────────────────────────────────────────
  if (!hasFirstSample) {
    return (
      <div className="system-widget-shell">
        <Titlebar pinned={pinned} onTogglePin={() => void setPinnedMode()} />
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
      <Titlebar pinned={pinned} onTogglePin={() => void setPinnedMode()} />

      <main className="system-widget-content">
        {isStale && (
          <div className="system-widget-stale" title={`Last sample at ${new Date(memory!.sampledAt).toLocaleTimeString()}`}>
            <span className="system-widget-stale-dot" aria-hidden="true" />
            stale · {formatStaleAge(memoryAge)}
          </div>
        )}

        <section className={`system-widget-tiles tiles-${heroTileCount}`}>
          {/* DISK is passive — the DRIVES section below is its
            * natural detail. Making it click-expand would just
            * duplicate that data. Visual: cursor-default + no
            * hover lift; passes `onClick={undefined}` to the
            * tile component to render as a non-interactive div. */}
          <StatTile
            kicker="Disk"
            value={diskValue}
            sub={diskSub}
            percent={diskPct}
            accent={diskPressureAccent(diskPct)}
            history={diskHistory}
            ariaLabel={`Disk ${diskValue} used.`}
          />
          <StatTile
            kicker="Memory"
            value={pct(memoryPct)}
            sub={memory ? `${formatBytes(memory.usedBytes)} / ${formatBytes(memory.totalBytes)}` : ""}
            percent={memoryPct ?? 0}
            accent="blue"
            history={memoryHistory}
            active={activeDetail === "memory"}
            onClick={() => toggleDetail("memory")}
            ariaLabel={`Memory ${pct(memoryPct)} used. Click to ${activeDetail === "memory" ? "hide" : "show"} top processes.`}
          />
          <StatTile
            kicker="CPU"
            value={pct(cpuPercent)}
            sub={cpuSub}
            percent={cpuPercent ?? 0}
            accent="green"
            history={cpuHistory}
            active={activeDetail === "cpu"}
            onClick={() => toggleDetail("cpu")}
            ariaLabel={`CPU ${pct(cpuPercent)} active. Click to ${activeDetail === "cpu" ? "hide" : "show"} top processes.`}
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
              active={activeDetail === "gpu"}
              onClick={gpu?.unavailable ? undefined : () => toggleDetail("gpu")}
              ariaLabel={`GPU ${gpu?.unavailable ? "not available" : pct(gpuPercent)}. ${gpu?.unavailable ? "" : `Click to ${activeDetail === "gpu" ? "hide" : "show"} top processes.`}`}
            />
          )}
        </section>

        {activeDetail === "memory" && (
          <DetailPanel
            title="Top processes by memory"
            accent="blue"
            rows={memoryDetail}
            emptyMessage="No memory data yet."
            onClose={() => setActiveDetail(null)}
          />
        )}
        {activeDetail === "cpu" && (
          <DetailPanel
            title="Top processes by CPU"
            accent="green"
            rows={cpuDetail}
            emptyMessage={memory ? "Nothing using CPU right now." : "No CPU data yet."}
            onClose={() => setActiveDetail(null)}
          />
        )}
        {activeDetail === "gpu" && (
          <DetailPanel
            title="Top processes by GPU"
            accent="teal"
            rows={gpuDetail}
            emptyMessage={gpu?.unavailable ? "GPU sampling unavailable." : "Nothing using the GPU right now."}
            onClose={() => setActiveDetail(null)}
          />
        )}

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
              {scanElapsedSec !== null && (
                <span>{formatScanElapsed(scanElapsedSec)} elapsed</span>
              )}
            </div>
          )}
          {scan?.status === "done" && scan.rootPath && (
            // The only navigate-to-main affordance in the widget.
            // Explicit, opt-in: clicking opens the Changes tab in
            // main with the existing focusMainWithView IPC. The
            // rest of the widget stays standalone.
            <button
              type="button"
              className="system-widget-scan-action"
              onClick={() => void nativeApi.focusMainWithView({ view: "changes" })}
              title="Open the Changes tab in the main app"
            >
              View changes →
            </button>
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
              // Static count footer — no longer a click-through
              // (widget is standalone). Users with 5+ drives can
              // hit the "open main window" titlebar button to
              // see the full list in the picker.
              <div className="system-widget-drive-more-static">
                + {drives.length - 4} more {drives.length - 4 === 1 ? "drive" : "drives"} (open main window for full list)
              </div>
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
 * Inline detail panel rendered between the hero tiles and the
 * DISK I/O section when a clickable tile is active. Shows a
 * top-N list of processes (or whatever rows the caller passes).
 *
 * Accent color matches the originating tile so the visual link
 * between trigger and panel reads at a glance — clicking the
 * green CPU tile produces a green-accented detail panel.
 */
function DetailPanel(props: {
  title: string;
  accent: TileAccent;
  rows: DetailRow[];
  emptyMessage: string;
  onClose: () => void;
}) {
  const { title, accent, rows, emptyMessage, onClose } = props;
  return (
    <section className={`system-widget-detail ${accent}`}>
      <div className="system-widget-detail-head">
        <span>{title}</span>
        <button
          type="button"
          className="system-widget-detail-close"
          aria-label="Close detail"
          title="Close (Esc)"
          onClick={onClose}
        >
          <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
            <path d="M2.5 2.5l5 5M7.5 2.5l-5 5" />
          </svg>
        </button>
      </div>
      {rows.length === 0 ? (
        <div className="system-widget-detail-empty">{emptyMessage}</div>
      ) : (
        <div className="system-widget-detail-list">
          {rows.map((row) => (
            <div className="system-widget-detail-row" key={row.key}>
              <span className="system-widget-detail-name" title={row.name}>{row.name}</span>
              <div className="system-widget-detail-bar" aria-hidden="true">
                <div className="system-widget-detail-fill" style={{ width: `${row.pct}%` }} />
              </div>
              <span className="system-widget-detail-value">{row.value}</span>
            </div>
          ))}
        </div>
      )}
    </section>
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
  active?: boolean;
  onClick?: () => void;
  ariaLabel: string;
}) {
  const { kicker, value, sub, percent, accent, dimmed = false, history, active = false, onClick, ariaLabel } = props;
  const clamped = Math.max(0, Math.min(100, Number.isFinite(percent) ? percent : 0));
  const className = [
    "system-widget-stat",
    accent,
    dimmed && "dimmed",
    active && "active",
    !onClick && "passive",
  ].filter(Boolean).join(" ");

  // Render as `<button>` only when clickable. Passive tiles
  // become a `<div>` so screen readers / keyboards don't tab
  // into something that does nothing on activate.
  if (onClick) {
    return (
      <button
        type="button"
        className={className}
        onClick={onClick}
        aria-pressed={active}
        aria-label={ariaLabel}
      >
        <StatTileBody
          kicker={kicker}
          value={value}
          sub={sub}
          clamped={clamped}
          history={history}
          accent={accent}
        />
      </button>
    );
  }
  return (
    <div className={className} aria-label={ariaLabel}>
      <StatTileBody
        kicker={kicker}
        value={value}
        sub={sub}
        clamped={clamped}
        history={history}
        accent={accent}
      />
    </div>
  );
}

function StatTileBody(props: {
  kicker: string;
  value: string;
  sub: string;
  clamped: number;
  history: number[];
  accent: TileAccent;
}) {
  const { kicker, value, sub, clamped, history, accent } = props;
  return (
    <>
      <div className="system-widget-stat-kicker">{kicker}</div>
      <div className="system-widget-stat-value-row">
        <span className="system-widget-stat-value">{value}</span>
        <Sparkline values={history} accent={accent} />
      </div>
      <div className="system-widget-stat-track" aria-hidden="true">
        <div className="system-widget-stat-fill" style={{ width: `${clamped}%` }} />
      </div>
      <div className="system-widget-stat-sub" title={sub}>{sub || " "}</div>
    </>
  );
}

function Sparkline({ values, accent }: { values: number[]; accent: TileAccent }) {
  if (values.length < 2) {
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
