import { execFile } from "node:child_process";
import * as FS from "node:fs/promises";
import * as Path from "node:path";
import { promisify } from "node:util";

import type { DiskIoProcessInfo, DiskIoSnapshot } from "./contracts";
import { deriveProcessMetadata } from "./processMonitor";

const execFileAsync = promisify(execFile);
const WINDOWS_TIMEOUT_MS = 10_000;

interface RawIo {
  pid: number;
  name: string;
  readBytes: number;
  writeBytes: number;
  exePath?: string | null;
  commandLine?: string | null;
  parentPid?: number | null;
  parentName?: string | null;
}

let lastLinuxSample: { sampledAt: number; byPid: Map<number, RawIo> } | null = null;

export async function sampleDiskIo(): Promise<DiskIoSnapshot> {
  const startedAt = Date.now();

  if (process.platform === "darwin") {
    return {
      processes: [],
      totalReadBytesPerSec: 0,
      totalWriteBytesPerSec: 0,
      sampledAt: startedAt,
      sampleElapsedMs: 0,
      hasRateBaseline: false,
      unavailable: true,
      platformNote:
        "macOS does not expose reliable per-process disk byte counters to unprivileged apps. Activity Monitor can show this through private/privileged system instrumentation.",
    };
  }

  try {
    const snap = process.platform === "win32"
      ? await sampleWindowsDiskIo(startedAt)
      : await sampleLinuxDiskIo(startedAt);
    return {
      ...snap,
      sampleElapsedMs: Date.now() - startedAt,
    };
  } catch (err) {
    return {
      processes: [],
      totalReadBytesPerSec: 0,
      totalWriteBytesPerSec: 0,
      sampledAt: startedAt,
      sampleElapsedMs: Date.now() - startedAt,
      hasRateBaseline: false,
      errorMessage: err instanceof Error ? err.message : String(err),
    };
  }
}

async function sampleWindowsDiskIo(sampledAt: number): Promise<DiskIoSnapshot> {
  const script = `
$ErrorActionPreference = 'SilentlyContinue'
$cimByPid = @{}
Get-CimInstance Win32_Process | ForEach-Object {
  $cimByPid[[int]$_.ProcessId] = $_
}
$procById = @{}
Get-Process | ForEach-Object {
  $cim = $cimByPid[[int]$_.Id]
  $path = $_.Path
  if (-not $path -and $cim) { $path = $cim.ExecutablePath }
  $procById[[int]$_.Id] = @{
    path = $path
    name = $_.ProcessName
    commandLine = if ($cim) { $cim.CommandLine } else { $null }
    parentPid = if ($cim) { $cim.ParentProcessId } else { $null }
  }
}
$rows = Get-CimInstance Win32_PerfFormattedData_PerfProc_Process |
  Where-Object { $_.IDProcess -gt 0 -and $_.Name -ne '_Total' -and $_.Name -ne 'Idle' } |
  ForEach-Object {
    $p = $procById[[int]$_.IDProcess]
    @{
      pid = [int]$_.IDProcess
      name = if ($p -and $p.name) { [string]$p.name } else { [string]$_.Name }
      readBytesPerSec = [double]$_.IOReadBytesPersec
      writeBytesPerSec = [double]$_.IOWriteBytesPersec
      exePath = if ($p) { $p.path } else { $null }
      commandLine = if ($p) { $p.commandLine } else { $null }
      parentPid = if ($p) { $p.parentPid } else { $null }
      parentName = if ($p -and $p.parentPid -and $procById[[int]$p.parentPid]) { [string]$procById[[int]$p.parentPid].name } else { $null }
    }
  }
$rows | ConvertTo-Json -Compress -Depth 3
`.trim();

  const { stdout } = await execFileAsync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", script],
    { timeout: WINDOWS_TIMEOUT_MS, maxBuffer: 32 * 1024 * 1024, windowsHide: true },
  );

  const cleaned = stdout.replace(/^\uFEFF/, "").trim();
  const parsed = cleaned ? JSON.parse(cleaned) : [];
  const rows = Array.isArray(parsed) ? parsed : [parsed];
  const processes: DiskIoProcessInfo[] = [];

  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const obj = row as Record<string, unknown>;
    const pid = Number(obj.pid);
    if (!Number.isFinite(pid) || pid <= 0) continue;
    const readBytesPerSec = Math.max(0, Number(obj.readBytesPerSec) || 0);
    const writeBytesPerSec = Math.max(0, Number(obj.writeBytesPerSec) || 0);
    if (readBytesPerSec + writeBytesPerSec <= 0) continue;
    const rawName = typeof obj.name === "string" ? obj.name : `pid-${pid}`;
    const name = rawName.endsWith(".exe") ? rawName : `${rawName}.exe`;
    const exePath = cleanOptionalString(obj.exePath);
    const commandLine = cleanOptionalString(obj.commandLine);
    const parentPid = parsePositiveNumber(obj.parentPid);
    const parentName = cleanOptionalString(obj.parentName);
    processes.push(enrichDiskIoProcessInfo({
      pid,
      name,
      readBytesPerSec,
      writeBytesPerSec,
      totalBytesPerSec: readBytesPerSec + writeBytesPerSec,
      readBytesTotal: null,
      writeBytesTotal: null,
      exePath,
      commandLine,
      parentPid,
      parentName,
    }));
  }

  processes.sort((a, b) => b.totalBytesPerSec - a.totalBytesPerSec);
  return {
    processes,
    totalReadBytesPerSec: processes.reduce((sum, p) => sum + p.readBytesPerSec, 0),
    totalWriteBytesPerSec: processes.reduce((sum, p) => sum + p.writeBytesPerSec, 0),
    sampledAt,
    sampleElapsedMs: 0,
    hasRateBaseline: true,
    platformNote:
      "Windows reports process I/O counters, which include filesystem and other kernel I/O issued by the process.",
  };
}

async function sampleLinuxDiskIo(sampledAt: number): Promise<DiskIoSnapshot> {
  const procEntries = await FS.readdir("/proc", { withFileTypes: true });
  const rawRows: RawIo[] = [];

  await Promise.all(procEntries.map(async (entry) => {
    if (!entry.isDirectory() || !/^\d+$/.test(entry.name)) return;
    const pid = Number(entry.name);
    const procDir = Path.join("/proc", entry.name);
    try {
      const ioRaw = await FS.readFile(Path.join(procDir, "io"), "utf8");
      const readBytes = readProcIoField(ioRaw, "read_bytes");
      const writeBytes = readProcIoField(ioRaw, "write_bytes");
      if (readBytes === null || writeBytes === null) return;
      const [commRaw, cmdRaw, exePath, statRaw] = await Promise.all([
        FS.readFile(Path.join(procDir, "comm"), "utf8").catch(() => ""),
        FS.readFile(Path.join(procDir, "cmdline"), "utf8").catch(() => ""),
        FS.readlink(Path.join(procDir, "exe")).catch(() => null),
        FS.readFile(Path.join(procDir, "stat"), "utf8").catch(() => ""),
      ]);
      const commandLine = cmdRaw.replace(/\0/g, " ").trim();
      const name = commRaw.trim() || commandLine.split(/\s+/)[0] || `pid-${pid}`;
      rawRows.push({
        pid,
        name,
        readBytes,
        writeBytes,
        commandLine,
        exePath,
        parentPid: readLinuxParentPid(statRaw),
      });
    } catch {
      // Process vanished or /proc/<pid>/io was not readable. Ignore it.
    }
  }));

  const previous = lastLinuxSample;
  const nextByPid = new Map(rawRows.map((row) => [row.pid, row]));
  lastLinuxSample = { sampledAt, byPid: nextByPid };
  const elapsedSec = previous ? Math.max(0.001, (sampledAt - previous.sampledAt) / 1000) : 0;

  const nameByPid = new Map(rawRows.map((row) => [row.pid, row.name]));
  const processes: DiskIoProcessInfo[] = rawRows.map((row) => {
    const prev = previous?.byPid.get(row.pid);
    const readBytesPerSec = prev ? Math.max(0, (row.readBytes - prev.readBytes) / elapsedSec) : 0;
    const writeBytesPerSec = prev ? Math.max(0, (row.writeBytes - prev.writeBytes) / elapsedSec) : 0;
    return enrichDiskIoProcessInfo({
      pid: row.pid,
      name: row.name,
      readBytesPerSec,
      writeBytesPerSec,
      totalBytesPerSec: readBytesPerSec + writeBytesPerSec,
      readBytesTotal: row.readBytes,
      writeBytesTotal: row.writeBytes,
      exePath: row.exePath ?? null,
      commandLine: row.commandLine,
      parentPid: row.parentPid ?? null,
      parentName: row.parentPid ? (nameByPid.get(row.parentPid) ?? null) : null,
    });
  }).filter((p) => previous && p.totalBytesPerSec > 0);

  processes.sort((a, b) => b.totalBytesPerSec - a.totalBytesPerSec);
  return {
    processes,
    totalReadBytesPerSec: processes.reduce((sum, p) => sum + p.readBytesPerSec, 0),
    totalWriteBytesPerSec: processes.reduce((sum, p) => sum + p.writeBytesPerSec, 0),
    sampledAt,
    sampleElapsedMs: 0,
    hasRateBaseline: Boolean(previous),
    platformNote:
      "Linux rates are derived from /proc/<pid>/io read_bytes and write_bytes deltas between samples.",
  };
}

function cleanOptionalString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function readLinuxParentPid(statRaw: string): number | null {
  const closeParen = statRaw.lastIndexOf(")");
  if (closeParen < 0) return null;
  const fields = statRaw.slice(closeParen + 1).trim().split(/\s+/);
  const ppid = Number(fields[1]);
  return Number.isFinite(ppid) && ppid > 0 ? ppid : null;
}

function parsePositiveNumber(value: unknown): number | null {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function enrichDiskIoProcessInfo(processInfo: DiskIoProcessInfo): DiskIoProcessInfo {
  const metadata = deriveProcessMetadata(processInfo);
  return {
    ...processInfo,
    commandPreview: metadata.commandPreview,
    workingDirectory: metadata.workingDirectory,
  };
}

function readProcIoField(raw: string, field: string): number | null {
  const line = raw.split("\n").find((candidate) => candidate.startsWith(`${field}:`));
  if (!line) return null;
  const value = Number(line.slice(field.length + 1).trim());
  return Number.isFinite(value) ? value : null;
}
