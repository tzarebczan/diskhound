import { execFile } from "node:child_process";
import * as OS from "node:os";
import { promisify } from "node:util";

import type { KillSignal, ProcessInfo, SystemMemorySnapshot } from "./contracts";

const execFileAsync = promisify(execFile);
// PowerShell Get-Process usually returns in 1-2s, but we give room for cold-
// start on slower boxes. Basic tasklist is snappier but lacks paths.
const POWERSHELL_TIMEOUT_MS = 12_000;
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
  // First sample has no baseline, so both cpu fields stay null.
  //
  // We emit TWO flavors:
  //   cpuPercent         — system-wide (divided by core count, 0–100).
  //                        Matches Task Manager / Activity Monitor so
  //                        numbers line up with what users already know.
  //   cpuPercentPerCore  — per-core (can exceed 100% on multi-threaded
  //                        workloads). For power users who want absolute
  //                        single-core load instead of relative share.
  const nowMs = Date.now();
  if (lastCpuSample && processes.length > 0) {
    const wallDeltaMs = Math.max(1, nowMs - lastCpuSample.sampledAt);
    const cores = Math.max(1, cpuCount);
    for (const p of processes) {
      if (typeof p.cpuTimeMs !== "number") continue;
      const prev = lastCpuSample.cpuTimeByPid.get(p.pid);
      if (prev === undefined) continue;
      const cpuDeltaMs = Math.max(0, p.cpuTimeMs - prev);
      const perCorePct = (cpuDeltaMs / wallDeltaMs) * 100;
      const perCoreClamped = Math.min(cores * 100, Math.max(0, perCorePct));
      p.cpuPercentPerCore = perCoreClamped;
      p.cpuPercent = Math.min(100, perCoreClamped / cores);
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
  const script = `
$ErrorActionPreference = 'SilentlyContinue'
$cimByPid = @{}
Get-CimInstance Win32_Process | ForEach-Object {
  $cimByPid[[int]$_.ProcessId] = $_
}
Get-Process | ForEach-Object {
  $cpuMs = $null
  try { $cpuMs = [int64]$_.TotalProcessorTime.TotalMilliseconds } catch { $cpuMs = $null }
  $cim = $cimByPid[[int]$_.Id]
  $path = $_.Path
  if (-not $path -and $cim) { $path = $cim.ExecutablePath }
  [PSCustomObject]@{
    Id = $_.Id
    ProcessName = $_.ProcessName
    WorkingSet64 = $_.WorkingSet64
    Path = $path
    CpuMs = $cpuMs
    ParentPid = if ($cim) { $cim.ParentProcessId } else { $null }
    CommandLine = if ($cim) { $cim.CommandLine } else { $null }
  }
} | ConvertTo-Json -Compress -Depth 3
`.trim();
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
    const exePath = cleanOptionalString(obj.Path);
    const commandLine = cleanOptionalString(obj.CommandLine);
    const parentPid = parsePositiveNumber(obj.ParentPid);

    processes.push(enrichProcessInfo({
      pid,
      name,
      memoryBytes,
      cpuPercent: null, // derived in sampleSystemMemory() using delta
      cpuPercentPerCore: null,
      // Get-Process without -IncludeUserName doesn't give owner info, but
      // only processes we can enumerate (i.e. most user-accessible ones)
      // appear — default to true and let taskkill surface access-denied
      // errors per-action.
      userOwned: !isKnownSystemProcess(name),
      exePath,
      commandLine,
      parentPid,
      cpuTimeMs,
    }));
  }

  return attachParentNames(processes);
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

function cleanOptionalString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function parsePositiveNumber(value: unknown): number | null {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function enrichProcessInfo(processInfo: ProcessInfo): ProcessInfo {
  const metadata = deriveProcessMetadata(processInfo);
  return {
    ...processInfo,
    commandPreview: metadata.commandPreview,
    workingDirectory: metadata.workingDirectory,
  };
}

function attachParentNames(processes: ProcessInfo[]): ProcessInfo[] {
  const nameByPid = new Map<number, string>();
  for (const p of processes) nameByPid.set(p.pid, p.name);
  return processes.map((p) => ({
    ...p,
    parentName: p.parentPid ? (nameByPid.get(p.parentPid) ?? null) : null,
  }));
}

export function deriveProcessMetadata(
  processInfo: Pick<ProcessInfo, "name" | "exePath" | "commandLine">,
): Pick<ProcessInfo, "commandPreview" | "workingDirectory"> {
  const commandLine = processInfo.commandLine?.trim() || null;
  const args = commandLine ? splitCommandLine(commandLine) : [];
  const commandPreview = commandLine
    ? buildCommandPreview(args, commandLine)
    : null;
  const workingDirectory = inferWorkingDirectory(args, processInfo.exePath ?? null);
  return { commandPreview, workingDirectory };
}

function buildCommandPreview(args: string[], commandLine: string): string {
  const source = args.length > 1 ? args.slice(1).join(" ") : commandLine;
  return truncateMiddle(source, 220);
}

function splitCommandLine(commandLine: string): string[] {
  const out: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;
  let escaping = false;
  for (let i = 0; i < commandLine.length; i++) {
    const ch = commandLine[i]!;
    if (escaping) {
      current += ch;
      escaping = false;
      continue;
    }
    if (ch === "\\") {
      const next = commandLine[i + 1];
      if (quote && (next === quote || next === "\\")) {
        escaping = true;
        continue;
      }
    }
    if ((ch === '"' || ch === "'") && (!quote || quote === ch)) {
      quote = quote ? null : ch;
      continue;
    }
    if (!quote && /\s/.test(ch)) {
      if (current) {
        out.push(current);
        current = "";
      }
      continue;
    }
    current += ch;
  }
  if (current) out.push(current);
  return out;
}

function inferWorkingDirectory(args: string[], exePath: string | null): string | null {
  if (args.length === 0) return null;
  const allowUnixAbsolute = !exePath || !isWindowsPath(exePath);
  for (let i = 1; i < args.length; i++) {
    const arg = args[i]!;
    const next = args[i + 1];
    const cwd = cwdFromOption(arg, next, allowUnixAbsolute);
    if (cwd) return cwd;
  }

  const exeKey = exePath ? normalizeProcessPath(exePath) : null;
  for (const arg of args.slice(1)) {
    const cleaned = stripOptionValueQuotes(arg);
    if (!isAbsolutePath(cleaned, allowUnixAbsolute)) continue;
    if (exeKey && normalizeProcessPath(cleaned) === exeKey) continue;
    const projectRoot = projectRootFromPath(cleaned);
    if (projectRoot) return projectRoot;
    const folder = looksLikeFilePath(cleaned) ? parentDir(cleaned) : cleaned;
    if (folder) return folder;
  }
  return null;
}

function cwdFromOption(arg: string, next: string | undefined, allowUnixAbsolute: boolean): string | null {
  const normalized = arg.toLowerCase();
  if ((normalized === "--cwd" || normalized === "--prefix" || arg === "-C") && next) {
    const cleaned = stripOptionValueQuotes(next);
    return isAbsolutePath(cleaned, allowUnixAbsolute) ? cleaned : null;
  }
  const match = arg.match(/^(?:--cwd|--prefix)=(.+)$/i);
  if (!match) return null;
  const cleaned = stripOptionValueQuotes(match[1] ?? "");
  return isAbsolutePath(cleaned, allowUnixAbsolute) ? cleaned : null;
}

function stripOptionValueQuotes(value: string): string {
  return value.replace(/^["']|["']$/g, "");
}

function isAbsolutePath(value: string, allowUnixAbsolute: boolean): boolean {
  return isWindowsPath(value) || (allowUnixAbsolute && value.startsWith("/"));
}

function isWindowsPath(value: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(value) || /^\\\\[^\\]+\\[^\\]+/.test(value);
}

function looksLikeFilePath(value: string): boolean {
  return /\.[A-Za-z0-9]{1,8}$/.test(value) || /[\\/]bin[\\/][^\\/]+$/.test(value);
}

function parentDir(value: string): string | null {
  const idx = Math.max(value.lastIndexOf("\\"), value.lastIndexOf("/"));
  if (idx <= 0) return null;
  if (/^[A-Za-z]:[\\/]?$/.test(value.slice(0, idx + 1))) return value.slice(0, idx + 1);
  return value.slice(0, idx);
}

function projectRootFromPath(value: string): string | null {
  const match = value.match(/^(.*?)[\\/]node_modules[\\/]/i);
  if (match?.[1]) return match[1];
  return null;
}

function normalizeProcessPath(value: string): string {
  return value.replace(/\//g, "\\").toLowerCase();
}

function truncateMiddle(value: string, max: number): string {
  if (value.length <= max) return value;
  const keep = Math.max(20, Math.floor((max - 3) / 2));
  return `${value.slice(0, keep)}...${value.slice(value.length - keep)}`;
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
      cpuPercentPerCore: null,
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
    ["-axo", "pid=,ppid=,rss=,pcpu=,comm=,args="],
    { timeout: TASKLIST_TIMEOUT_MS, maxBuffer: 32 * 1024 * 1024 },
  );

  const lines = stdout.split("\n");
  const processes: ProcessInfo[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    // PID PPID RSS %CPU COMMAND ARGS
    const match = trimmed.match(/^(\d+)\s+(\d+)\s+(\d+)\s+([\d.]+)\s+(\S+)(?:\s+(.*))?$/);
    if (!match) continue;
    const pid = Number.parseInt(match[1], 10);
    const parentPid = Number.parseInt(match[2], 10);
    const rssKb = Number.parseInt(match[3], 10);
    const cpu = Number.parseFloat(match[4]);
    const name = (match[5] ?? "").trim();
    const commandLine = cleanOptionalString(match[6]);

    if (!Number.isFinite(pid) || pid <= 0 || !name) continue;

    // On Unix `ps` already reports %CPU as system-wide percent (matches
    // Activity Monitor). Multiply by cpuCount to derive per-core for
    // parity with the Windows Get-Process path.
    const cores = Math.max(1, OS.cpus().length);
    const sysPct = Number.isFinite(cpu) ? cpu : null;
    const perCore = sysPct !== null ? Math.min(cores * 100, sysPct * cores) : null;
    processes.push(enrichProcessInfo({
      pid,
      name,
      memoryBytes: rssKb * 1024,
      cpuPercent: sysPct,
      cpuPercentPerCore: perCore,
      userOwned: true,
      commandLine,
      parentPid: Number.isFinite(parentPid) && parentPid > 0 ? parentPid : null,
    }));
  }

  return attachParentNames(processes);
}
