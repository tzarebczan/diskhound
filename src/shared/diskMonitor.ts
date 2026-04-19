import { execFile } from "node:child_process";
import * as FS from "node:fs/promises";
import * as Path from "node:path";
import { promisify } from "node:util";

import type { DiskDelta, DiskSpaceInfo, MonitoringSnapshot } from "./contracts";

const execFileAsync = promisify(execFile);
const BASELINE_FILE = "disk-baselines.json";
/**
 * How many historical drive-level deltas to keep. With a 30-min check cadence
 * this is ~10 days of signal — plenty to render a timeline on the Changes tab
 * without bloating the persisted JSON beyond ~50 KB.
 */
const DELTA_HISTORY_CAP = 500;

interface PersistedState {
  previousDrives: Record<string, DiskSpaceInfo>;
  lastFullScanAt: number | null;
  lastDrives?: DiskSpaceInfo[];
  lastDeltas?: DiskDelta[];
  lastCheckedAt?: number;
  /** Rolling history of drive-level deltas (newest first). */
  deltaHistory?: DiskDelta[];
}

let previousDriveMap = new Map<string, DiskSpaceInfo>();
let lastFullScanAt: number | null = null;
let persistDir: string | null = null;
let lastDrives: DiskSpaceInfo[] = [];
let lastDeltas: DiskDelta[] = [];
let lastCheckedAt = 0;
let deltaHistory: DiskDelta[] = [];

// ── Initialization (call once at startup) ───────────────────

export async function initDiskMonitor(dataDir: string): Promise<void> {
  persistDir = dataDir;
  try {
    const raw = await FS.readFile(Path.join(dataDir, BASELINE_FILE), "utf8");
    const state = JSON.parse(raw) as PersistedState;
    previousDriveMap = new Map(Object.entries(state.previousDrives ?? {}));
    lastFullScanAt = state.lastFullScanAt ?? null;
    lastDrives = Array.isArray(state.lastDrives) ? state.lastDrives : [];
    lastDeltas = Array.isArray(state.lastDeltas) ? state.lastDeltas : [];
    lastCheckedAt =
      typeof state.lastCheckedAt === "number" && Number.isFinite(state.lastCheckedAt)
        ? state.lastCheckedAt
        : 0;
    deltaHistory = Array.isArray(state.deltaHistory)
      ? state.deltaHistory.slice(0, DELTA_HISTORY_CAP)
      : [];
  } catch {
    // No existing baseline — fresh start
  }
}

async function persistState(): Promise<void> {
  if (!persistDir) return;
  const state: PersistedState = {
    previousDrives: Object.fromEntries(previousDriveMap),
    lastFullScanAt,
    lastDrives,
    lastDeltas,
    lastCheckedAt,
    deltaHistory,
  };
  try {
    await FS.mkdir(persistDir, { recursive: true });
    await FS.writeFile(
      Path.join(persistDir, BASELINE_FILE),
      JSON.stringify(state, null, 2),
      "utf8",
    );
  } catch {
    // Non-fatal — baselines will be lost on restart
  }
}

// ── Public API ──────────────────────────────────────────────

export async function getDiskSpace(): Promise<DiskSpaceInfo[]> {
  if (process.platform === "win32") {
    return getWindowsDiskSpace();
  }
  return getUnixDiskSpace();
}

export async function checkDiskDeltas(): Promise<MonitoringSnapshot> {
  const drives = await getDiskSpace();
  const deltas: DiskDelta[] = [];
  const now = Date.now();

  for (const drive of drives) {
    const prev = previousDriveMap.get(drive.drive);
    if (prev) {
      const deltaBytes = drive.freeBytes - prev.freeBytes;
      const deltaPercent = prev.totalBytes > 0
        ? ((drive.freeBytes - prev.freeBytes) / prev.totalBytes) * 100
        : 0;

      // Only record meaningful changes (> 1 MB noise floor)
      if (Math.abs(deltaBytes) > 1_048_576) {
        deltas.push({
          drive: drive.drive,
          previousFreeBytes: prev.freeBytes,
          currentFreeBytes: drive.freeBytes,
          deltaBytes,
          deltaPercent,
          measuredAt: now,
        });
      }
    }
  }

  previousDriveMap = new Map(drives.map((d) => [d.drive, d]));
  lastDrives = drives;
  lastDeltas = deltas;
  lastCheckedAt = now;

  // Append any meaningful deltas from this check to the rolling timeline so
  // the UI can render drive-level events between full scans.
  if (deltas.length > 0) {
    deltaHistory = [...deltas, ...deltaHistory].slice(0, DELTA_HISTORY_CAP);
  }

  void persistState();

  return {
    drives: lastDrives,
    deltas: lastDeltas,
    lastFullScanAt,
    lastCheckedAt,
  };
}

export function getMonitoringSnapshot(): MonitoringSnapshot {
  return {
    drives: lastDrives,
    deltas: lastDeltas,
    lastFullScanAt,
    lastCheckedAt,
  };
}

export function markFullScan(): void {
  lastFullScanAt = Date.now();
  void persistState();
}

export function getLastFullScanAt(): number | null {
  return lastFullScanAt;
}

/** Return the rolling drive-level delta timeline, newest first. */
export function getDiskDeltaHistory(): DiskDelta[] {
  return deltaHistory.slice();
}

// ── Platform-specific disk space queries ────────────────────

async function getWindowsDiskSpace(): Promise<DiskSpaceInfo[]> {
  try {
    const { stdout } = await execFileAsync("wmic", [
      "logicaldisk",
      "where", "DriveType=3",
      "get", "DeviceID,FreeSpace,Size",
      "/format:csv",
    ], { timeout: 10_000 });

    const lines = stdout.trim().split(/\r?\n/).filter((l) => l.trim());
    const drives: DiskSpaceInfo[] = [];

    for (const line of lines.slice(1)) {
      const parts = line.split(",");
      if (parts.length < 4) continue;
      const deviceId = parts[1]?.trim();
      const freeSpace = parseInt(parts[2]?.trim() ?? "0", 10);
      const totalSize = parseInt(parts[3]?.trim() ?? "0", 10);

      if (!deviceId || isNaN(freeSpace) || isNaN(totalSize) || totalSize === 0) continue;

      drives.push({
        drive: deviceId,
        totalBytes: totalSize,
        freeBytes: freeSpace,
        usedBytes: totalSize - freeSpace,
        usedPercent: ((totalSize - freeSpace) / totalSize) * 100,
        timestamp: Date.now(),
      });
    }

    return drives;
  } catch {
    return getWindowsDiskSpaceFallback();
  }
}

async function getWindowsDiskSpaceFallback(): Promise<DiskSpaceInfo[]> {
  try {
    const script = `Get-PSDrive -PSProvider FileSystem | Where-Object { $_.Used -ne $null } | Select-Object Name, Used, Free | ConvertTo-Json`;
    const { stdout } = await execFileAsync("powershell", ["-NoProfile", "-Command", script], {
      timeout: 15_000,
    });

    const parsed = JSON.parse(stdout);
    const items = Array.isArray(parsed) ? parsed : [parsed];
    const drives: DiskSpaceInfo[] = [];

    for (const item of items) {
      const name = `${item.Name}:`;
      const used = Number(item.Used) || 0;
      const free = Number(item.Free) || 0;
      const total = used + free;
      if (total === 0) continue;

      drives.push({
        drive: name,
        totalBytes: total,
        freeBytes: free,
        usedBytes: used,
        usedPercent: (used / total) * 100,
        timestamp: Date.now(),
      });
    }

    return drives;
  } catch {
    return [];
  }
}

async function getUnixDiskSpace(): Promise<DiskSpaceInfo[]> {
  try {
    const { stdout } = await execFileAsync("df", ["-P", "-k"], { timeout: 10_000 });
    const lines = stdout.trim().split("\n").slice(1);
    const drives: DiskSpaceInfo[] = [];

    for (const line of lines) {
      const parts = line.trim().split(/\s+/);
      if (parts.length < 6) continue;

      const totalKb = parseInt(parts[1] ?? "0", 10);
      const usedKb = parseInt(parts[2] ?? "0", 10);
      const freeKb = parseInt(parts[3] ?? "0", 10);
      const mount = parts[5] ?? "";

      if (totalKb === 0 || mount.startsWith("/snap") || mount.startsWith("/boot")) continue;

      drives.push({
        drive: mount,
        totalBytes: totalKb * 1024,
        freeBytes: freeKb * 1024,
        usedBytes: usedKb * 1024,
        usedPercent: totalKb > 0 ? (usedKb / totalKb) * 100 : 0,
        timestamp: Date.now(),
      });
    }

    return drives;
  } catch {
    return [];
  }
}
