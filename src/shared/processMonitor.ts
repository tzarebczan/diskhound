import { execFile } from "node:child_process";
import * as OS from "node:os";
import { promisify } from "node:util";

import type { KillSignal, ProcessInfo, SystemMemorySnapshot } from "./contracts";

const execFileAsync = promisify(execFile);
// PowerShell Get-Process usually returns in 1-2s, but we give room for cold-
// start on slower boxes. Basic tasklist is snappier but lacks paths.
const POWERSHELL_TIMEOUT_MS = 8_000;
const TASKLIST_TIMEOUT_MS = 15_000;

/** Cached CPU times from the previous sample, keyed by PID. Used to derive
 *  cpuPercent by diffing cumulative CPU time against wall-clock between
 *  samples. */
interface CpuSampleState {
  sampledAt: number;
  cpuTimeByPid: Map<number, number>;
}

let lastCpuSample: CpuSampleState | null = null;

/**
 * Sample the current system memory + running processes.
 * Windows: `Get-Process` via PowerShell (fast, gives exe paths),
 *          falls back to `tasklist /fo csv /nh` if PowerShell fails.
 * macOS/Linux: `ps -axo pid,rss,%cpu,comm`
 */
export async function sampleSystemMemory(): Promise<SystemMemorySnapshot> {
  const startedAt = Date.now();
  const totalBytes = OS.totalmem();
  const freeBytes = OS.freemem();
  const usedBytes = totalBytes - freeBytes;
  const cpuCount = OS.cpus().length;
  const loadAvg = process.platform === "win32" ? null : OS.loadavg()[0] ?? null;

  let processes: ProcessInfo[] = [];
  let errorMessage: string | undefined;
  try {
    processes = process.platform === "win32"
      ? await sampleProcessesWindows()
      : await sampleProcessesUnix();
  } catch (error) {
    errorMessage = error instanceof Error ? error.message : String(error);
  }

  // Derive cpuPercent from cumulative CPU time delta vs wall-clock delta.
  // First sample has no baseline, so cpuPercent is null for all procs.
  const nowMs = Date.now();
  if (lastCpuSample && processes.length > 0) {
    const wallDeltaMs = Math.max(1, nowMs - lastCpuSample.sampledAt);
    const cores = Math.max(1, cpuCount);
    for (const p of processes) {
      if (typeof p.cpuTimeMs !== "number") continue;
      const prev = lastCpuSample.cpuTimeByPid.get(p.pid);
      if (prev === undefined) continue;
      const cpuDeltaMs = Math.max(0, p.cpuTimeMs - prev);
      // CPU% normalized to a single core. 200% means 2 full cores used.
      const pct = (cpuDeltaMs / wallDeltaMs) * 100;
      // Cap at a sensible max (cores * 100) — noisy delta can briefly overshoot
      p.cpuPercent = Math.min(cores * 100, Math.max(0, pct));
    }
  }

  // Save CPU baseline for the next sample
  const cpuTimeByPid = new Map<number, number>();
  for (const p of processes) {
    if (typeof p.cpuTimeMs === "number") {
      cpuTimeByPid.set(p.pid, p.cpuTimeMs);
    }
  }
  lastCpuSample = { sampledAt: nowMs, cpuTimeByPid };

  // Sort by memory descending so the biggest offenders are first
  processes.sort((a, b) => b.memoryBytes - a.memoryBytes);

  return {
    totalBytes,
    freeBytes,
    usedBytes,
    usedPercent: totalBytes > 0 ? (usedBytes / totalBytes) * 100 : 0,
    cpuCount,
    loadAvg,
    processes,
    sampledAt: nowMs,
    errorMessage,
    sampleElapsedMs: nowMs - startedAt,
  };
}

/**
 * Kill a process. "soft" sends SIGTERM / allows graceful shutdown; "hard"
 * sends SIGKILL / /F. Requires admin for protected system processes.
 */
export async function killProcess(pid: number, signal: KillSignal): Promise<void> {
  if (!Number.isFinite(pid) || pid <= 0) {
    throw new Error("Invalid PID");
  }

  if (process.platform === "win32") {
    const args = signal === "hard" ? ["/F", "/PID", String(pid)] : ["/PID", String(pid)];
    await execFileAsync("taskkill", args, { windowsHide: true });
    return;
  }

  // Unix: process.kill does the right thing
  process.kill(pid, signal === "hard" ? "SIGKILL" : "SIGTERM");
}

// ── Platform implementations ──────────────────────────────

async function sampleProcessesWindows(): Promise<ProcessInfo[]> {
  // PowerShell Get-Process is our primary path — typically 1-2s and
  // gives us PID, name, working set, exe path, and cumulative CPU time
  // in a single call. Fall back to basic tasklist if PS is disabled or
  // locked down (some hardened environments block it).
  try {
    return await sampleViaPowerShell();
  } catch (psError) {
    try {
      return await runTasklist(false);
    } catch (tasklistError) {
      const psMsg = psError instanceof Error ? psError.message : String(psError);
      const tlMsg = tasklistError instanceof Error ? tasklistError.message : String(tasklistError);
      throw new Error(
        `Process sampling failed. PowerShell: ${psMsg}. tasklist: ${tlMsg}.`,
      );
    }
  }
}

/**
 * Use PowerShell's Get-Process to collect processes in one call. Returns
 * rich data (working set, exe path, cumulative CPU time) in ~1-2s.
 * Explicitly skips the profile so startup is snappy.
 */
async function sampleViaPowerShell(): Promise<ProcessInfo[]> {
  const script =
    "Get-Process | Select-Object Id, ProcessName, WorkingSet64, Path, " +
    "@{N='CpuMs';E={[int64]$_.TotalProcessorTime.TotalMilliseconds}} | " +
    "ConvertTo-Json -Compress -Depth 2";
  const { stdout } = await execFileAsync(
    "powershell",
    ["-NoProfile", "-NonInteractive", "-Command", script],
    { timeout: POWERSHELL_TIMEOUT_MS, maxBuffer: 32 * 1024 * 1024, windowsHide: true },
  );

  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch (error) {
    throw new Error(`Get-Process returned non-JSON output: ${(error as Error).message}`);
  }

  const items = Array.isArray(parsed) ? parsed : parsed ? [parsed] : [];
  const processes: ProcessInfo[] = [];

  for (const raw of items) {
    if (!raw || typeof raw !== "object") continue;
    const obj = raw as Record<string, unknown>;
    const pid = Number(obj.Id);
    if (!Number.isFinite(pid) || pid <= 0) continue;
    const baseName = typeof obj.ProcessName === "string" ? obj.ProcessName : "";
    if (!baseName) continue;

    // PowerShell ProcessName strips ".exe" — add it back on Windows for
    // consistency with tasklist/taskkill and the Kill action.
    const name = baseName.endsWith(".exe") ? baseName : `${baseName}.exe`;
    const memoryBytes = Number(obj.WorkingSet64) || 0;
    const cpuTimeMs = typeof obj.CpuMs === "number" ? obj.CpuMs : Number(obj.CpuMs) || 0;
    const exePath = typeof obj.Path === "string" && obj.Path.length > 0 ? obj.Path : null;

    processes.push({
      pid,
      name,
      memoryBytes,
      cpuPercent: null, // derived in sampleSystemMemory() using delta
      // Get-Process without -IncludeUserName doesn't give owner info, but
      // only processes we can enumerate (i.e. most user-accessible ones)
      // appear — default to true and let taskkill surface access-denied
      // errors per-action.
      userOwned: !isKnownSystemProcess(name),
      exePath,
      cpuTimeMs,
    });
  }

  return processes;
}

/** Pattern list for processes we consider "system" even if PS lists them. */
const SYSTEM_PROCESS_NAMES = new Set<string>([
  "system", "secure system", "registry", "idle",
  "smss.exe", "csrss.exe", "wininit.exe", "services.exe", "lsass.exe",
  "winlogon.exe", "fontdrvhost.exe", "dwm.exe", "sihost.exe", "ctfmon.exe",
  "svchost.exe", "msmpeng.exe", "mpdefendercoreservice.exe",
  "searchindexer.exe", "searchprotocolhost.exe", "searchfilterhost.exe",
  "securityhealthservice.exe", "runtimebroker.exe", "audiodg.exe",
  "spoolsv.exe", "mousocoreworker.exe", "taskhostw.exe",
]);

function isKnownSystemProcess(name: string): boolean {
  return SYSTEM_PROCESS_NAMES.has(name.toLowerCase());
}

async function runTasklist(verbose: boolean): Promise<ProcessInfo[]> {
  // Verbose (/v) fields: "Image Name","PID","Session Name","Session#","Mem Usage","Status","User Name","CPU Time","Window Title"
  // Basic fields:         "Image Name","PID","Session Name","Session#","Mem Usage"
  const args = verbose ? ["/fo", "csv", "/nh", "/v"] : ["/fo", "csv", "/nh"];
  const { stdout } = await execFileAsync(
    "tasklist",
    args,
    { timeout: TASKLIST_TIMEOUT_MS, maxBuffer: 32 * 1024 * 1024, windowsHide: true },
  );

  const rows = stdout.split(/\r?\n/).filter(Boolean);
  const processes: ProcessInfo[] = [];
  const minFields = verbose ? 7 : 5;

  for (const row of rows) {
    const fields = parseCsvRow(row);
    if (fields.length < minFields) continue;

    const name = fields[0] ?? "";
    const pid = Number.parseInt(fields[1] ?? "0", 10);
    const memKb = parseWindowsMemKb(fields[4] ?? "");
    // User name only present in the /v output — default to user-owned so
    // the Kill actions stay enabled when we can't tell.
    const userName = verbose ? (fields[6] ?? "") : "";

    if (!name || !Number.isFinite(pid) || pid <= 0) continue;

    processes.push({
      pid,
      name,
      memoryBytes: memKb * 1024,
      cpuPercent: null, // tasklist doesn't give instantaneous CPU %
      userOwned: verbose ? !/\b(SYSTEM|LOCAL SERVICE|NETWORK SERVICE)\b/i.test(userName) : true,
    });
  }

  return processes;
}

/** Parse a single CSV row with quoted fields. Handles embedded commas inside quotes. */
function parseCsvRow(row: string): string[] {
  const out: string[] = [];
  let current = "";
  let inQuotes = false;
  for (let i = 0; i < row.length; i++) {
    const ch = row[i];
    if (ch === '"') {
      if (inQuotes && row[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === "," && !inQuotes) {
      out.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  out.push(current);
  return out;
}

/** "123,456 K" or "0 K" → 123456 */
function parseWindowsMemKb(value: string): number {
  const digits = value.replace(/[^\d]/g, "");
  return Number.parseInt(digits, 10) || 0;
}

async function sampleProcessesUnix(): Promise<ProcessInfo[]> {
  // ps -axo pid,rss,%cpu,comm — portable across macOS/Linux.
  // rss is in KB.
  const { stdout } = await execFileAsync(
    "ps",
    ["-axo", "pid,rss,%cpu,comm"],
    { timeout: TASKLIST_TIMEOUT_MS, maxBuffer: 32 * 1024 * 1024 },
  );

  const lines = stdout.split("\n").slice(1); // skip header
  const processes: ProcessInfo[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    // PID RSS %CPU COMMAND
    const match = trimmed.match(/^(\d+)\s+(\d+)\s+([\d.]+)\s+(.+)$/);
    if (!match) continue;
    const pid = Number.parseInt(match[1], 10);
    const rssKb = Number.parseInt(match[2], 10);
    const cpu = Number.parseFloat(match[3]);
    const name = (match[4] ?? "").trim();

    if (!Number.isFinite(pid) || pid <= 0 || !name) continue;

    processes.push({
      pid,
      name,
      memoryBytes: rssKb * 1024,
      cpuPercent: Number.isFinite(cpu) ? cpu : null,
      userOwned: true,
    });
  }

  return processes;
}
