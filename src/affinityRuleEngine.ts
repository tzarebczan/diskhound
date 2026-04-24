import { spawn } from "node:child_process";
import * as Path from "node:path";

import type { AffinityRule, ProcessInfo } from "./shared/contracts";

/**
 * Persistent CPU-affinity rule enforcement.
 *
 * The engine is ticked by the existing process-monitor poll (every
 * ~5 s). On each tick:
 *   1. Load enabled rules from settings.
 *   2. Scan the current ProcessInfo list; for each process, find the
 *      first enabled rule whose pattern matches its exe name/path.
 *   3. Read the process's current affinity mask. If it already matches
 *      the rule → no-op.
 *   4. Otherwise call SetProcessAffinityMask (via PowerShell
 *      `ProcessorAffinity` property). Update the rule's lastAppliedAt
 *      and appliedCount.
 *
 * Rule-first matching: the first enabled rule wins. Users manage
 * conflicts by ordering their rules (not implemented UI-wise yet —
 * rules are ordered by creation time for v1).
 *
 * Notes:
 *   - Per-process affinity reads are batched in one PowerShell call
 *     across all candidates in a tick, to avoid ~200 ms × N PS spawn
 *     latency on machines with many rules.
 *   - We match the exe name case-insensitively; patterns are stored
 *     lowercased by the settings normalizer so match-time is cheap.
 *   - Errors are swallowed and logged — a rule that fails (process
 *     protected, permission denied, etc.) just stays un-applied; we
 *     retry next tick.
 */

export interface AffinityApplyResult {
  ruleId: string;
  pid: number;
  processName: string;
  previousMask: number;
  newMask: number;
  ok: boolean;
  error?: string;
}

/**
 * Run one pass of rule enforcement against a process sample. Returns
 * the set of applied results (successful or failed) so the caller
 * can update settings with fresh lastAppliedAt / appliedCount.
 */
export async function enforceAffinityRules(
  rules: AffinityRule[],
  processes: ProcessInfo[],
): Promise<AffinityApplyResult[]> {
  if (process.platform !== "win32") return [];
  const enabled = rules.filter((r) => r.enabled);
  if (enabled.length === 0) return [];

  // For each running process, find the matching rule (if any). Skip
  // processes without an exePath — we can't pattern-match basenames
  // or paths on them (typically system / protected procs).
  const matches: Array<{ rule: AffinityRule; proc: ProcessInfo }> = [];
  for (const proc of processes) {
    if (!proc.exePath) continue;
    const basename = Path.basename(proc.exePath).toLowerCase();
    const fullPath = proc.exePath.toLowerCase();
    for (const rule of enabled) {
      let isMatch = false;
      if (rule.matchType === "exe_name") {
        isMatch = basename === rule.matchPattern;
      } else {
        isMatch = fullPath.includes(rule.matchPattern);
      }
      if (isMatch) {
        matches.push({ rule, proc });
        break;
      }
    }
  }
  if (matches.length === 0) return [];

  // Read current affinities in a single PowerShell call to keep per-
  // tick latency bounded. One spawn handles an arbitrary number of
  // PIDs; the script prints `pid<tab>mask` lines which we parse.
  const pids = matches.map((m) => m.proc.pid);
  const currentMasks = await readAffinitiesBatch(pids);

  const results: AffinityApplyResult[] = [];
  for (const { rule, proc } of matches) {
    const current = currentMasks.get(proc.pid);
    if (current === undefined) {
      // Process disappeared between sample and affinity read, or
      // access denied. Skip — we'll catch it next tick.
      continue;
    }
    if (current === rule.affinityMask) {
      // Already pinned to the right mask — rule is satisfied, no-op.
      continue;
    }
    const applyResult = await applyAffinity(proc.pid, rule.affinityMask);
    results.push({
      ruleId: rule.id,
      pid: proc.pid,
      processName: proc.name,
      previousMask: current,
      newMask: rule.affinityMask,
      ok: applyResult.ok,
      error: applyResult.error,
    });
  }
  return results;
}

/**
 * Batched affinity read. Emits one PS pipeline that enumerates the
 * requested PIDs and prints `<pid>\t<mask>` for each successful read;
 * silently omits PIDs that errored (usually access denied on protected
 * processes).
 */
async function readAffinitiesBatch(pids: number[]): Promise<Map<number, number>> {
  if (pids.length === 0) return new Map();
  const pidsStr = pids.join(",");
  const script = `Get-Process -Id ${pidsStr} -ErrorAction SilentlyContinue | ForEach-Object { "$($_.Id)\`t$($_.ProcessorAffinity.ToInt64())" }`;
  const output = await new Promise<string>((resolve) => {
    const child = spawn(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", script],
      { stdio: ["ignore", "pipe", "ignore"], windowsHide: true },
    );
    let buf = "";
    child.stdout?.on("data", (c) => { buf += String(c); });
    const timeout = setTimeout(() => {
      try { child.kill(); } catch { /* noop */ }
      resolve("");
    }, 5000);
    child.on("error", () => { clearTimeout(timeout); resolve(""); });
    child.on("exit", () => { clearTimeout(timeout); resolve(buf); });
  });
  const map = new Map<number, number>();
  for (const line of output.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const [pidStr, maskStr] = trimmed.split("\t");
    const pid = Number(pidStr);
    const mask = Number(maskStr);
    if (Number.isFinite(pid) && Number.isFinite(mask)) {
      map.set(pid, mask);
    }
  }
  return map;
}

async function applyAffinity(
  pid: number,
  mask: number,
): Promise<{ ok: boolean; error?: string }> {
  const result = await new Promise<{ ok: boolean; error?: string }>((resolve) => {
    const child = spawn(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `$p = Get-Process -Id ${pid} -ErrorAction Stop; $p.ProcessorAffinity = [IntPtr]${mask}`,
      ],
      { stdio: ["ignore", "ignore", "pipe"], windowsHide: true },
    );
    let stderrBuf = "";
    child.stderr?.on("data", (c) => { stderrBuf += String(c); });
    const timeout = setTimeout(() => {
      try { child.kill(); } catch { /* noop */ }
      resolve({ ok: false, error: "timeout" });
    }, 5000);
    child.on("error", (err) => {
      clearTimeout(timeout);
      resolve({ ok: false, error: err.message });
    });
    child.on("exit", (code) => {
      clearTimeout(timeout);
      if (code === 0) resolve({ ok: true });
      else resolve({ ok: false, error: stderrBuf.trim() || `exit ${code}` });
    });
  });
  return result;
}
