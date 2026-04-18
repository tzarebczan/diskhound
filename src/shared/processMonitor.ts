import { execFile } from "node:child_process";
import * as OS from "node:os";
import { promisify } from "node:util";

import type { KillSignal, ProcessInfo, SystemMemorySnapshot } from "./contracts";

const execFileAsync = promisify(execFile);
// tasklist /v on a busy system can take 5-10+ seconds — give it room.
const LIST_TIMEOUT_MS = 15_000;

/**
 * Sample the current system memory + running processes.
 * Windows: uses `tasklist /fo csv /v`
 * macOS/Linux: uses `ps -axo pid,rss,%cpu,comm`
 */
export async function sampleSystemMemory(): Promise<SystemMemorySnapshot> {
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
    sampledAt: Date.now(),
    errorMessage,
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
  // Try `/v` first — it gives us the owning user, which lets us flag
  // system-vs-user processes. If that fails (the /v variant requires the
  // Terminal Services subsystem and can also be blocked by AV/EDR), fall
  // back to the basic call which works almost anywhere.
  try {
    return await runTasklist(true);
  } catch (verboseError) {
    try {
      return await runTasklist(false);
    } catch (basicError) {
      const verboseMsg = verboseError instanceof Error ? verboseError.message : String(verboseError);
      const basicMsg = basicError instanceof Error ? basicError.message : String(basicError);
      throw new Error(
        `tasklist failed. With /v: ${verboseMsg}. Basic: ${basicMsg}. ` +
        `This can happen when the Terminal Services service is disabled or ` +
        `security software blocks tasklist.exe.`,
      );
    }
  }
}

async function runTasklist(verbose: boolean): Promise<ProcessInfo[]> {
  // Verbose (/v) fields: "Image Name","PID","Session Name","Session#","Mem Usage","Status","User Name","CPU Time","Window Title"
  // Basic fields:         "Image Name","PID","Session Name","Session#","Mem Usage"
  const args = verbose ? ["/fo", "csv", "/nh", "/v"] : ["/fo", "csv", "/nh"];
  const { stdout } = await execFileAsync(
    "tasklist",
    args,
    { timeout: LIST_TIMEOUT_MS, maxBuffer: 32 * 1024 * 1024, windowsHide: true },
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
    { timeout: LIST_TIMEOUT_MS, maxBuffer: 32 * 1024 * 1024 },
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
