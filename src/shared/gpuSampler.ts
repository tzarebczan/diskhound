import { execFile } from "node:child_process";
import { promisify } from "node:util";

import type { GpuAdapter, GpuProcessInfo, GpuSnapshot } from "./contracts";

const execFileAsync = promisify(execFile);

// GPU sampling is a one-shot PowerShell call. Get-Counter has a large
// cold-start cost (WMI provider spin-up can push a first-run invocation
// past 10 s on some machines — user saw "10025 ms · error: Command
// failed: ..." with the 10 s cap). Bumped to 20 s so first-run
// doesn't spuriously fail; subsequent calls are cached and typically
// return in 400-1500 ms.
const GPU_SAMPLE_TIMEOUT_MS = 20_000;

// The WMI call (Get-CimInstance Win32_VideoController) is the single
// slowest piece — 2-5 s cold-start, and the data never changes between
// samples (adapter name / driver version / AdapterRAM are static). We
// cache the result after the first successful call and skip the WMI
// query on subsequent samples.
interface CachedAdapterInfo {
  name: string;
  driverVersion: string | null;
  adapterRAM: number;
}
let cachedAdapterList: CachedAdapterInfo[] | null = null;

// Script builder. On warm runs (`includeAdapters=false`) we skip the
// expensive Get-CimInstance call and rely on the module-level cache.
// Output is always a JSON blob with four sections (adapters may be
// empty on warm runs; caller fills from cache):
//   adapters: Win32_VideoController display list (cold only)
//   engine:   per (pid, luid, engtype) utilisation percent
//   procMem:  per (pid, luid) dedicated + shared bytes
//   adMem:    per (luid) dedicated + shared bytes for the whole adapter
//   procs:    Get-Process rows (id, name, path) so we can label PIDs
//
// Everything wrapped in try/catch so a single counter family failing
// (e.g. on a VM without WDDM 2.0) doesn't kill the whole snapshot.
function buildScript(includeAdapters: boolean): string {
  const adaptersBlock = includeAdapters
    ? `$adapters = @(); try { $adapters = Get-CimInstance Win32_VideoController | Select-Object Name, DriverVersion, AdapterRAM | ForEach-Object { @{ name = $_.Name; driverVersion = $_.DriverVersion; adapterRAM = [int64]$_.AdapterRAM } } } catch {}`
    : `$adapters = @()`;
  return `
$ErrorActionPreference = 'SilentlyContinue'
${adaptersBlock}
$engine = @()
try { $engine = (Get-Counter '\\GPU Engine(*)\\Utilization Percentage' -ErrorAction SilentlyContinue).CounterSamples | ForEach-Object { @{ path = $_.Path; value = [double]$_.CookedValue } } } catch {}
$procMem = @()
try { $procMem = (Get-Counter '\\GPU Process Memory(*)\\Dedicated Usage','\\GPU Process Memory(*)\\Shared Usage' -ErrorAction SilentlyContinue).CounterSamples | ForEach-Object { @{ path = $_.Path; value = [double]$_.CookedValue } } } catch {}
$adMem = @()
try { $adMem = (Get-Counter '\\GPU Adapter Memory(*)\\Dedicated Usage','\\GPU Adapter Memory(*)\\Shared Usage' -ErrorAction SilentlyContinue).CounterSamples | ForEach-Object { @{ path = $_.Path; value = [double]$_.CookedValue } } } catch {}
$procs = @()
try { $procs = Get-Process | ForEach-Object { @{ id = $_.Id; name = $_.Name; path = $_.Path } } } catch {}
@{ adapters = $adapters; engine = $engine; procMem = $procMem; adMem = $adMem; procs = $procs } | ConvertTo-Json -Depth 4 -Compress
`.trim();
}

// ── Path parsing ────────────────────────────────────────────────────────
//
// Windows counter paths look like:
//   \\DESKTOP-XYZ\gpu engine(pid_41700_luid_0x00000000_0x00064b70_phys_0_eng_3_engtype_3d)\utilization percentage
//   \\DESKTOP-XYZ\gpu process memory(pid_41700_luid_0x00000000_0x00064b70_phys_0)\dedicated usage
//   \\DESKTOP-XYZ\gpu adapter memory(luid_0x00000000_0x00064b70_phys_0)\dedicated usage
//
// We parse out the pid / luid / engtype from the instance substring
// (the parenthesised bit) and the metric name from the tail.

interface ParsedCounter {
  pid: number | null;
  luid: string | null;
  engType: string | null;
  metric: string;
}

const PID_RE = /pid_(\d+)_/i;
const LUID_RE = /luid_(0x[0-9a-f]+_0x[0-9a-f]+)/i;
const ENGTYPE_RE = /engtype_([a-z0-9]+)/i;

function parseCounterPath(rawPath: string): ParsedCounter | null {
  const lower = rawPath.toLowerCase();
  const parenStart = lower.indexOf("(");
  const parenEnd = lower.indexOf(")", parenStart + 1);
  if (parenStart < 0 || parenEnd < 0) return null;
  const instance = lower.slice(parenStart + 1, parenEnd);
  const metric = lower.slice(parenEnd + 1).replace(/^\\/, "").trim();
  const pid = PID_RE.exec(instance)?.[1];
  const luid = LUID_RE.exec(instance)?.[1];
  const engType = ENGTYPE_RE.exec(instance)?.[1];
  return {
    pid: pid ? parseInt(pid, 10) : null,
    luid: luid ?? null,
    engType: engType ?? null,
    metric,
  };
}

/**
 * Normalize engine-type strings to nice display labels. Windows emits
 * lowercase hex-ish tokens (3d, videodecode, videoencode, copy); we
 * map known ones to Title Case. Unknown ones pass through so future
 * engine types don't get swallowed.
 */
function prettifyEngineType(token: string): string {
  switch (token) {
    case "3d":           return "3D";
    case "compute_0":
    case "compute_1":
    case "compute":      return "Compute";
    case "videoprocessing":
    case "videoprocess":  return "Video";
    case "videodecode":   return "Decode";
    case "videoencode":   return "Encode";
    case "copy":          return "Copy";
    case "crypto":        return "Crypto";
    case "other":         return "Other";
    default:              return token.replace(/_/g, " ");
  }
}

// ── Sampler ────────────────────────────────────────────────────────────

interface RawCounter {
  path: string;
  value: number;
}
interface RawAdapter {
  name: string;
  driverVersion: string | null;
  adapterRAM: number;
}
interface RawProc {
  id: number;
  name: string;
  path: string | null;
}
interface RawPayload {
  adapters: RawAdapter[];
  engine: RawCounter[];
  procMem: RawCounter[];
  adMem: RawCounter[];
  procs: RawProc[];
}

/** Sample GPU state. Windows-only; returns `unavailable: true` on
 *  other platforms. */
export async function sampleGpu(): Promise<GpuSnapshot> {
  const startedAt = Date.now();
  if (process.platform !== "win32") {
    return {
      adapters: [],
      processes: [],
      sampledAt: startedAt,
      sampleElapsedMs: 0,
      unavailable: true,
    };
  }

  try {
    // Cold-run: include the Win32_VideoController query. Warm runs
    // skip it and reuse the cached adapter list (name / driver /
    // adapterRAM don't change between samples).
    const includeAdapters = cachedAdapterList === null;
    const script = buildScript(includeAdapters);
    const { stdout } = await execFileAsync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", script],
      { timeout: GPU_SAMPLE_TIMEOUT_MS, maxBuffer: 32 * 1024 * 1024 },
    );
    // Strip any UTF-16 BOM Windows PowerShell 5.1 sometimes prepends
    // to redirected output. JSON.parse throws on a leading U+FEFF,
    // leaving the entire snapshot blank even though the payload is
    // otherwise well-formed. Also guard against an empty stdout
    // (happens on systems where both Get-Counter families failed).
    const cleaned = stdout.replace(/^\uFEFF/, "").trim();
    if (!cleaned) {
      return {
        adapters: [],
        processes: [],
        sampledAt: startedAt,
        sampleElapsedMs: Date.now() - startedAt,
        unavailable: true,
      };
    }
    const payload = JSON.parse(cleaned) as RawPayload;
    // Warm-run paths pass the cached adapter list through as if PS
    // had returned it; cold-run paths populate the cache from the
    // fresh WMI result so subsequent calls go fast.
    const rawAdapters = Array.isArray(payload.adapters) ? payload.adapters : [];
    if (includeAdapters && rawAdapters.length > 0) {
      cachedAdapterList = rawAdapters.map((a) => ({
        name: a.name,
        driverVersion: a.driverVersion,
        adapterRAM: a.adapterRAM,
      }));
    } else if (!includeAdapters && cachedAdapterList) {
      payload.adapters = cachedAdapterList;
    }
    return buildSnapshotFromPayload(payload, startedAt);
  } catch (err) {
    return {
      adapters: [],
      processes: [],
      sampledAt: startedAt,
      sampleElapsedMs: Date.now() - startedAt,
      errorMessage: err instanceof Error ? err.message : String(err),
    };
  }
}

function buildSnapshotFromPayload(
  payload: RawPayload,
  startedAt: number,
): GpuSnapshot {
  // Normalize PowerShell output quirks: single-item arrays deserialize as
  // scalars; ConvertTo-Json may give null arrays; fields may be missing.
  const asArray = <T>(v: unknown): T[] => {
    if (!v) return [];
    return Array.isArray(v) ? (v as T[]) : [v as T];
  };
  const rawAdapters = asArray<RawAdapter>(payload.adapters);
  const engineCounters = asArray<RawCounter>(payload.engine);
  const procMemCounters = asArray<RawCounter>(payload.procMem);
  const adapterMemCounters = asArray<RawCounter>(payload.adMem);
  const procs = asArray<RawProc>(payload.procs);

  // ── Per-adapter aggregates (keyed by luid) ──────────────────────────
  interface AdapterAgg {
    id: string;
    dedicatedBytesUsed: number;
    sharedBytesUsed: number;
    enginePercent: Record<string, number>;
    utilizationPercent: number;
  }
  const adapters = new Map<string, AdapterAgg>();
  const getAdapter = (luid: string): AdapterAgg => {
    let a = adapters.get(luid);
    if (!a) {
      a = {
        id: luid,
        dedicatedBytesUsed: 0,
        sharedBytesUsed: 0,
        enginePercent: {},
        utilizationPercent: 0,
      };
      adapters.set(luid, a);
    }
    return a;
  };

  for (const c of adapterMemCounters) {
    const parsed = parseCounterPath(c.path);
    if (!parsed?.luid) continue;
    const a = getAdapter(parsed.luid);
    if (parsed.metric.includes("dedicated")) a.dedicatedBytesUsed += c.value;
    else if (parsed.metric.includes("shared")) a.sharedBytesUsed += c.value;
  }

  // ── Per-process aggregates ──────────────────────────────────────────
  interface ProcAgg {
    pid: number;
    adapterId: string | null;
    dedicatedBytes: number;
    sharedBytes: number;
    enginePercent: Record<string, number>;
  }
  const processes = new Map<number, ProcAgg>();
  const getProc = (pid: number): ProcAgg => {
    let p = processes.get(pid);
    if (!p) {
      p = {
        pid,
        adapterId: null,
        dedicatedBytes: 0,
        sharedBytes: 0,
        enginePercent: {},
      };
      processes.set(pid, p);
    }
    return p;
  };

  for (const c of procMemCounters) {
    const parsed = parseCounterPath(c.path);
    if (!parsed?.pid) continue;
    const p = getProc(parsed.pid);
    if (parsed.luid) p.adapterId = parsed.luid;
    if (parsed.metric.includes("dedicated")) p.dedicatedBytes += c.value;
    else if (parsed.metric.includes("shared")) p.sharedBytes += c.value;
  }

  for (const c of engineCounters) {
    const parsed = parseCounterPath(c.path);
    if (!parsed?.pid || !parsed?.engType) continue;
    const label = prettifyEngineType(parsed.engType);
    // Clamp to 0-100; perf counters occasionally glitch beyond 100%.
    const clamped = Math.max(0, Math.min(100, c.value));
    const p = getProc(parsed.pid);
    // Multiple instances per (pid, engtype) can exist (different queue
    // indices); take the MAX rather than summing so our numbers match
    // what Task Manager reports. Summing inflates to multi-hundred %.
    p.enginePercent[label] = Math.max(p.enginePercent[label] ?? 0, clamped);
    if (parsed.luid) p.adapterId = parsed.luid;
    // Roll up into the adapter aggregate too (its utilisation is the
    // max of any engine across any process on it).
    const a = getAdapter(parsed.luid ?? "unknown");
    a.enginePercent[label] = Math.max(a.enginePercent[label] ?? 0, clamped);
  }

  // ── Match procs (pid → name/path) ───────────────────────────────────
  const procInfoByPid = new Map<number, RawProc>();
  for (const p of procs) {
    procInfoByPid.set(p.id, p);
  }

  const finalProcesses: GpuProcessInfo[] = [];
  for (const [pid, agg] of processes) {
    const info = procInfoByPid.get(pid);
    const utilization = Math.max(0, ...Object.values(agg.enginePercent));
    // Filter out processes with no measurable usage — Windows emits
    // counter entries for every PID that's ever touched the GPU,
    // including long-dead ones + zero-utilisation idlers. Keeps the
    // UI table focused on processes actually doing work.
    if (
      agg.dedicatedBytes === 0 &&
      agg.sharedBytes === 0 &&
      utilization < 0.5
    ) {
      continue;
    }
    finalProcesses.push({
      pid,
      name: info?.name ?? `pid-${pid}`,
      exePath: info?.path ?? null,
      adapterId: agg.adapterId,
      dedicatedBytes: agg.dedicatedBytes,
      sharedBytes: agg.sharedBytes,
      enginePercent: agg.enginePercent,
      utilizationPercent: utilization,
    });
  }
  // Sort descending by utilisation, then by dedicated memory as tiebreaker.
  finalProcesses.sort(
    (a, b) =>
      b.utilizationPercent - a.utilizationPercent ||
      b.dedicatedBytes - a.dedicatedBytes,
  );

  // ── Finalise adapters ──────────────────────────────────────────────
  // Match adapter LUIDs to Win32_VideoController entries by index order
  // — Windows doesn't expose the LUID→device mapping from CIM cheaply,
  // but both lists are ordered by physical adapter index. In single-GPU
  // machines this is trivially correct; multi-GPU machines may mis-match
  // names vs counters (rare). AdapterRAM is limited to UInt32 (~4 GB
  // max), useless for modern GPUs — pass it through but caller should
  // prefer dedicatedBytesUsed (which has no ceiling).
  let adapterArray = [...adapters.values()];
  // Phantom-adapter filter. Windows emits counter entries for every
  // adapter the WDDM scheduler knows about — including software
  // renderers like WARP and the Microsoft Basic Display Adapter that
  // exist on virtually every machine. These appear as extra LUIDs with
  // zero activity and create confusing "Adapter 2" entries in the UI
  // on systems that only have one physical GPU. When the counter list
  // has MORE adapters than Win32_VideoController reports, trim the
  // extras by keeping the highest-scoring ones (activity + VRAM).
  if (rawAdapters.length > 0 && adapterArray.length > rawAdapters.length) {
    adapterArray = adapterArray
      .map((a) => ({
        a,
        score:
          Math.max(0, ...Object.values(a.enginePercent)) +
          a.dedicatedBytesUsed / 1e9 +
          a.sharedBytesUsed / 1e10,
      }))
      .sort((x, y) => y.score - x.score)
      .slice(0, rawAdapters.length)
      .map(({ a }) => a);
  }
  const adapterList: GpuAdapter[] = [];
  adapterArray.forEach((a, idx) => {
    const wmi = rawAdapters[idx];
    const utilization = Math.max(0, ...Object.values(a.enginePercent));
    adapterList.push({
      id: a.id,
      name: wmi?.name ?? `Adapter ${idx + 1}`,
      driverVersion: wmi?.driverVersion ?? null,
      // AdapterRAM is often capped at 4 GB on modern GPUs by UInt32
      // overflow. Treat anything suspicious as unknown.
      dedicatedBytesTotal:
        wmi && wmi.adapterRAM > 0 && wmi.adapterRAM < 0xFFFF_FFFF
          ? wmi.adapterRAM
          : null,
      dedicatedBytesUsed: a.dedicatedBytesUsed,
      sharedBytesUsed: a.sharedBytesUsed,
      enginePercent: a.enginePercent,
      utilizationPercent: utilization,
    });
  });

  // Fallback: no counter-matched adapters but WMI reported one. Happens
  // on machines where the counter provider is disabled (some VM images).
  if (adapterList.length === 0 && rawAdapters.length > 0) {
    rawAdapters.forEach((wmi, idx) => {
      adapterList.push({
        id: `wmi-${idx}`,
        name: wmi.name,
        driverVersion: wmi.driverVersion,
        dedicatedBytesTotal:
          wmi.adapterRAM > 0 && wmi.adapterRAM < 0xFFFF_FFFF
            ? wmi.adapterRAM
            : null,
        dedicatedBytesUsed: 0,
        sharedBytesUsed: 0,
        enginePercent: {},
        utilizationPercent: 0,
      });
    });
  }

  return {
    adapters: adapterList,
    processes: finalProcesses,
    sampledAt: startedAt,
    sampleElapsedMs: Date.now() - startedAt,
    unavailable: adapterList.length === 0 && finalProcesses.length === 0,
  };
}
