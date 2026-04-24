import * as FS from "node:fs";
import * as FSP from "node:fs/promises";
import * as Path from "node:path";
import { randomUUID } from "node:crypto";
import { execSync, spawn } from "node:child_process";

import type { EasyMoveRecord, EasyMoveResult, PathActionResult } from "./contracts";

const STORE_FILENAME = "easy-moves.json";

let dataDir = "";
let records: EasyMoveRecord[] = [];

// Crash-log hook injected by main.ts at init so easyMove can trace its
// decision path. Without this, "EasyMove failed with EPERM" is a black
// box — we can't tell which tier (rename / copy / robocopy) failed, or
// whether isElevated returned what we expected. The hook is optional
// so the module still functions on non-Electron callers.
type LogFn = (tag: string, msg: string) => void;
let logCrash: LogFn = () => { /* noop default */ };

export function setEasyMoveLogger(fn: LogFn): void {
  logCrash = fn;
}

export function initEasyMoveStore(dir: string): void {
  dataDir = dir;
  records = [];
  const filePath = Path.join(dataDir, STORE_FILENAME);
  try {
    if (FS.existsSync(filePath)) {
      records = JSON.parse(FS.readFileSync(filePath, "utf-8"));
    }
  } catch {
    records = [];
  }
}

function persist(): void {
  if (!dataDir) return;
  try {
    FS.mkdirSync(dataDir, { recursive: true });
    FS.writeFileSync(
      Path.join(dataDir, STORE_FILENAME),
      JSON.stringify(records, null, 2),
    );
  } catch {
    // Best effort
  }
}

export function getEasyMoves(): EasyMoveRecord[] {
  return [...records];
}

/**
 * Normalize a path for comparison — lowercase on Windows, resolve, strip trailing sep.
 */
function normForCompare(p: string): string {
  const resolved = Path.resolve(p).replace(/[\\/]+$/, "");
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

/**
 * Check if `child` is inside (or equal to) `parent`.
 */
function isInsideOrEqual(child: string, parent: string): boolean {
  const nc = normForCompare(child);
  const np = normForCompare(parent);
  return nc === np || nc.startsWith(np + Path.sep) || nc.startsWith(np + "/");
}

/**
 * Move a file/folder to a new location and create a link at the original path.
 *
 * Cross-platform linking strategy:
 * - Directories: junction on Windows (no admin), symlink on macOS/Linux
 * - Files on Windows: hardlink (no admin needed, same volume) or mklink via cmd
 * - Files on macOS/Linux: symlink
 */
export async function easyMove(
  sourcePath: string,
  destinationDir: string,
): Promise<EasyMoveResult> {
  logCrash("easy-move", `start src=${sourcePath} dest=${destinationDir}`);
  try {
    // [P1] Guard: destination must not be inside the source tree
    if (isInsideOrEqual(destinationDir, sourcePath)) {
      return {
        ok: false,
        message: "Cannot move into a subfolder of the source — that would create a recursive loop.",
      };
    }

    // Try fs.stat first. On Windows-protected paths (e.g., Hyper-V
    // VHDX files under C:\\ProgramData\\Microsoft\\Windows\\Virtual
    // Hard Disks\\, which are TrustedInstaller-owned), fs.stat can
    // throw EPERM even for admins because Node doesn't enable
    // SeBackupPrivilege by default. The actual MOVE (fs.rename) often
    // succeeds anyway — rename only needs write access to the source
    // directory, not the file's metadata handle. So: stat first for
    // fast info; on perm error, fall back to lstat (which uses a
    // different CreateFile flag set) or guess from the path, then
    // attempt the move regardless. If the move fails, the caller
    // gets a real, accurate error from that failure.
    let isDirectory = false;
    let size = 0;
    let statSucceeded = false;
    try {
      const stat = await FSP.stat(sourcePath);
      isDirectory = stat.isDirectory();
      size = stat.size;
      statSucceeded = true;
      logCrash("easy-move", `stat ok isDir=${isDirectory} size=${size}`);
    } catch (statErr) {
      const statCode = (statErr as NodeJS.ErrnoException)?.code;
      const permy = statCode === "EPERM" || statCode === "EACCES";
      logCrash("easy-move", `stat failed code=${statCode ?? "?"} permy=${permy}`);
      if (!permy) {
        // ENOENT / other — not a permission issue, rethrow to outer catch.
        throw statErr;
      }
      // Permission-flavoured stat failure. Try lstat (which uses
      // FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_BACKUP_SEMANTICS
      // under the hood on Windows and works for more paths).
      try {
        const lstat = await FSP.lstat(sourcePath);
        isDirectory = lstat.isDirectory();
        size = lstat.size;
        statSucceeded = true;
      } catch {
        // Both stat and lstat failed. Guess isDirectory from the
        // filename (presence of extension = file). Proceed with
        // the move — rename can still succeed.
        isDirectory = !/\.[^\\/]+$/.test(Path.basename(sourcePath));
        size = 0;
      }
    }
    // `statSucceeded` is kept for future diagnostics — harmless if unused.
    void statSucceeded;

    // Build destination path
    const baseName = Path.basename(sourcePath);
    const destPath = Path.join(destinationDir, baseName);

    // Check destination doesn't already exist
    if (FS.existsSync(destPath)) {
      return { ok: false, message: `Destination already exists: ${destPath}` };
    }

    // Ensure destination directory exists
    await FSP.mkdir(destinationDir, { recursive: true });

    // Move strategy — four tiers, each only attempted if the previous
    // failed. Escalates in capability:
    //   1. fs.rename: atomic same-volume move. Fastest.
    //   2. fs.copyFile + unlink: cross-drive fallback.
    //   3. robocopy /move /b: backup-semantics move using
    //      SeBackupPrivilege. The only built-in tool that can move
    //      TrustedInstaller-owned files (e.g. Hyper-V VHDX under
    //      ProgramData\Microsoft\Windows\Virtual Hard Disks\) because
    //      Node's fs doesn't enable SeBackupPrivilege on its own.
    //      Requires admin; we skip this tier when not elevated.
    //   4. Defer to caller via requiresElevation: the renderer will
    //      prompt for UAC and call easyMoveElevated, which re-runs
    //      from step 3 in an elevated process.
    let moveSucceeded = false;
    let lastMoveError: unknown = null;
    try {
      await FSP.rename(sourcePath, destPath);
      moveSucceeded = true;
      logCrash("easy-move", `rename ok src=${sourcePath} dest=${destPath}`);
    } catch (renameErr) {
      lastMoveError = renameErr;
      // Try the copy + delete fallback only if rename wasn't a
      // permission error — for permission errors, copy will fail
      // identically (Node's fs uses the same underlying CreateFile).
      // Skipping the dead-end copy attempt shaves seconds off the
      // user-visible failure path and lands cleanly in the robocopy
      // escalation below.
      const renameCode = (renameErr as NodeJS.ErrnoException)?.code;
      const renameIsPerm = renameCode === "EPERM" || renameCode === "EACCES";
      logCrash("easy-move", `rename failed code=${renameCode ?? "?"} permy=${renameIsPerm}`);
      if (!renameIsPerm) {
        try {
          if (isDirectory) {
            await copyDirRecursive(sourcePath, destPath);
            await FSP.rm(sourcePath, { recursive: true, force: true });
          } else {
            await FSP.copyFile(sourcePath, destPath);
            await FSP.unlink(sourcePath);
          }
          moveSucceeded = true;
        } catch (copyErr) {
          lastMoveError = copyErr;
        }
      }
    }
    if (!moveSucceeded && process.platform === "win32") {
      // Only try robocopy when we're elevated — /b requires admin.
      // If not elevated, skip to the requiresElevation signal below
      // so the renderer can offer a UAC retry (which WILL be
      // elevated, and can then reach robocopy).
      const { isElevated } = await import("../elevation");
      const elevated = await isElevated();
      logCrash("easy-move", `entering robocopy branch, isElevated=${elevated}`);
      if (elevated) {
        logCrash("easy-move", `invoking robocopy src=${sourcePath} dest=${destPath}`);
        const roboResult = await robocopyMove(sourcePath, destPath, isDirectory);
        logCrash(
          "easy-move",
          `robocopy result ok=${roboResult.ok} exit=${roboResult.exitCode ?? "?"} message=${(roboResult.message ?? "").slice(0, 200)}`,
        );
        if (roboResult.ok) {
          moveSucceeded = true;
        } else {
          // robocopy failed even with admin. At this point either the
          // file is genuinely locked by another process (WSL with VHDX
          // open, Hyper-V VM running, etc.) or an ACL deny applies
          // even to admins. Return a specific, actionable error and
          // skip the outer catch's generic "locked" message that lost
          // the robocopy diagnostic.
          return {
            ok: false,
            message:
              `${Path.basename(sourcePath)}: robocopy /b also failed (${
                roboResult.message ?? "exit " + roboResult.exitCode
              }). ` +
              `The file is likely open in another process (e.g. Hyper-V VM for a .vhdx, WSL for ext4.vhdx, ` +
              `a running dump consumer for .dmp). Stop the other process and retry.`,
          };
        }
      } else {
        // Non-elevated hitting a path we can't move — signal the
        // renderer to offer UAC retry. Short-circuit the outer catch.
        return {
          ok: false,
          requiresElevation: true,
          message:
            `${Path.basename(sourcePath)} may require admin rights (Windows-protected path). ` +
            `Retry with admin — DiskHound will use an elevated helper to perform the move.`,
        };
      }
    }
    if (!moveSucceeded) {
      throw lastMoveError ?? new Error("Move failed for unknown reason");
    }
    logCrash("easy-move", `move phase complete, creating link at source`);

    // Create link at the original location
    try {
      await createPlatformLink(destPath, sourcePath, isDirectory);
    } catch (linkError) {
      // Link failed — try to move it back so we don't leave the user in a broken state
      let rolledBack = false;
      try {
        await FSP.rename(destPath, sourcePath);
        rolledBack = true;
      } catch {
        try {
          if (isDirectory) {
            await copyDirRecursive(destPath, sourcePath);
            await FSP.rm(destPath, { recursive: true, force: true });
          } else {
            await FSP.copyFile(destPath, sourcePath);
            await FSP.unlink(destPath);
          }
          rolledBack = true;
        } catch {
          // Rollback also failed — file is stranded at destPath
        }
      }

      if (!rolledBack) {
        // Persist a recovery record so the user can find and recover the file
        const strandedRecord: EasyMoveRecord = {
          id: randomUUID(),
          originalPath: sourcePath,
          movedToPath: destPath,
          symlinkPath: sourcePath,
          size,
          movedAt: Date.now(),
          isDirectory,
          stranded: true,
        };
        records.push(strandedRecord);
        persist();

        return {
          ok: false,
          message: `File was moved to ${destPath} but linking failed and rollback also failed. Use the Easy Move tab to recover it.`,
          record: strandedRecord,
        };
      }

      return {
        ok: false,
        message: `Moved but linking failed (rolled back): ${linkError instanceof Error ? linkError.message : String(linkError)}`,
      };
    }

    const record: EasyMoveRecord = {
      id: randomUUID(),
      originalPath: sourcePath,
      movedToPath: destPath,
      symlinkPath: sourcePath,
      size,
      movedAt: Date.now(),
      isDirectory,
    };

    records.push(record);
    persist();

    return { ok: true, message: `Moved and linked: ${baseName}`, record };
  } catch (error) {
    logCrash(
      "easy-move",
      `outer catch error code=${(error as NodeJS.ErrnoException)?.code ?? "?"} msg=${(error instanceof Error ? error.message : String(error)).slice(0, 200)}`,
    );
    // Windows-protected paths (anything under \Windows\LiveKernelReports,
    // some of \Windows\System32, System Volume Information, etc.) throw
    // EPERM / EACCES on plain `stat` for non-admin users — before we
    // ever get to the rename. The raw "EPERM: operation not permitted,
    // stat 'C:\\Windows\\...'" is technically accurate but reads as a
    // bug; translate to something actionable. Moving these files also
    // typically FAILS even when elevated because the OS has them open
    // or ACL-locks them, so we also warn about that.
    const code = (error as NodeJS.ErrnoException)?.code;
    if (code === "EPERM" || code === "EACCES" || code === "EBUSY") {
      const name = Path.basename(sourcePath);
      // Probe the current elevation state so we give the user a
      // message that actually applies. Historically we surfaced this
      // as "needs admin" unconditionally, but:
      //   - Users running elevated hit this error too (WSL-locked
      //     VHDX, Defender scan in flight, OneDrive mid-sync, etc.).
      //     Telling them to "retry with admin" is confusing.
      //   - EBUSY / sharing-violation is the most common cause,
      //     NOT permission. An elevated retry wouldn't help.
      // We only offer the UAC retry when non-elevated AND the code is
      // a permission-flavoured one; otherwise we give a "file is
      // locked" message with actionable suggestions.
      const { isElevated } = await import("../elevation");
      const elevated = await isElevated();
      if (!elevated && (code === "EPERM" || code === "EACCES")) {
        return {
          ok: false,
          requiresElevation: true,
          message: `${name} may require admin rights. Retry with admin to attempt the move.`,
        };
      }
      return {
        ok: false,
        message:
          `Couldn't access ${name} (${code}). Another process is likely holding the file open — common culprits: ` +
          `WSL (for .vhdx), Hyper-V, Windows Defender, OneDrive sync, or an antivirus scan. ` +
          `Close the app using it or wait a moment and try again.`,
      };
    }
    return {
      ok: false,
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Record an EasyMove that was performed out-of-process (by the
 * UAC-elevated PowerShell sibling spawned from main.ts). The actual
 * filesystem move + link creation already happened; we just need to
 * persist the record so the user can undo it later from the Easy Move
 * tab. Returns the same `EasyMoveResult` shape as `easyMove` for
 * caller parity.
 *
 * `isDirectory` and `size` are passed in from main.ts, which stat'd
 * the DESTINATION path after the elevated move succeeded (source is
 * now a symlink/junction, so stat'ing it would deref).
 */
export function recordElevatedEasyMove(params: {
  sourcePath: string;
  destinationPath: string;
  size: number;
  isDirectory: boolean;
}): EasyMoveResult {
  const record: EasyMoveRecord = {
    id: randomUUID(),
    originalPath: params.sourcePath,
    movedToPath: params.destinationPath,
    symlinkPath: params.sourcePath,
    size: params.size,
    movedAt: Date.now(),
    isDirectory: params.isDirectory,
  };
  records.push(record);
  persist();
  return {
    ok: true,
    message: `Moved and linked: ${Path.basename(params.sourcePath)}`,
    record,
  };
}

/**
 * Create a platform-appropriate link.
 *
 * - Windows dirs: junction (no admin)
 * - Windows files: mklink via cmd (works without admin on Win10+/Dev Mode)
 *   Falls back to hardlink if on same volume.
 * - macOS/Linux: standard symlink
 */
async function createPlatformLink(
  target: string,
  linkPath: string,
  isDirectory: boolean,
): Promise<void> {
  if (process.platform === "win32") {
    if (isDirectory) {
      // Junction — no admin required
      await FSP.symlink(target, linkPath, "junction");
    } else {
      // Try symlink first (works with Developer Mode on Win10+)
      try {
        await FSP.symlink(target, linkPath, "file");
      } catch {
        // Fall back to mklink via cmd.exe
        try {
          execSync(
            `mklink "${linkPath}" "${target}"`,
            { stdio: "ignore", windowsHide: true },
          );
        } catch {
          // Last resort: hardlink (only works on same volume)
          await FSP.link(target, linkPath);
        }
      }
    }
  } else {
    // macOS / Linux — standard symlinks
    await FSP.symlink(target, linkPath, isDirectory ? "dir" : "file");
  }
}

/**
 * Move a file/folder back to its original location (undo the link).
 */
export async function easyMoveBack(recordId: string): Promise<PathActionResult> {
  const idx = records.findIndex((r) => r.id === recordId);
  if (idx < 0) {
    return { ok: false, message: "Move record not found" };
  }

  const record = records[idx];

  try {
    // Verify the symlink/junction still exists
    const linkStat = await FSP.lstat(record.symlinkPath).catch(() => null);
    if (linkStat?.isSymbolicLink()) {
      await FSP.unlink(record.symlinkPath);
    } else if (linkStat) {
      // Might be a hardlink — remove it
      await FSP.unlink(record.symlinkPath);
    } else {
      // Link is gone — continue if the moved file still exists
      if (!FS.existsSync(record.movedToPath)) {
        records.splice(idx, 1);
        persist();
        return { ok: false, message: "Both link and moved file are missing" };
      }
    }

    // Check that the moved file still exists
    if (!FS.existsSync(record.movedToPath)) {
      records.splice(idx, 1);
      persist();
      return { ok: false, message: "Moved file no longer exists at destination" };
    }

    // Move it back
    try {
      await FSP.rename(record.movedToPath, record.originalPath);
    } catch {
      // Cross-drive fallback
      const stat = await FSP.stat(record.movedToPath);
      if (stat.isDirectory()) {
        await copyDirRecursive(record.movedToPath, record.originalPath);
        await FSP.rm(record.movedToPath, { recursive: true, force: true });
      } else {
        await FSP.copyFile(record.movedToPath, record.originalPath);
        await FSP.unlink(record.movedToPath);
      }
    }

    records.splice(idx, 1);
    persist();

    return { ok: true, message: `Restored: ${Path.basename(record.originalPath)}` };
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

async function copyDirRecursive(src: string, dest: string): Promise<void> {
  await FSP.mkdir(dest, { recursive: true });
  const entries = await FSP.readdir(src, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = Path.join(src, entry.name);
    const destPath = Path.join(dest, entry.name);
    if (entry.isDirectory()) {
      await copyDirRecursive(srcPath, destPath);
    } else {
      await FSP.copyFile(srcPath, destPath);
    }
  }
}

/**
 * Robocopy-based move with backup semantics. Ships with every Windows
 * install and is the only built-in tool that reliably moves files
 * under restrictive ACLs (TrustedInstaller-owned VHDX files, etc.).
 *
 * /move         = move (copy + delete source)
 * /b            = backup mode — uses SeBackupPrivilege (needs admin)
 * /copy:DAT     = copy Data + Attributes + Timestamps; skip ACLs so the
 *                 destination gets the destination folder's default ACL
 *                 rather than the source's restrictive one.
 * /r:1 /w:1     = retry once, wait 1 s — don't hang forever on a lock.
 * /njh /njs /ndl /nc /ns /np = quiet output (no job header/summary, no
 *                 dir list, no class/size/progress columns). Keeps the
 *                 pipe traffic minimal so we don't backpressure.
 *
 * Exit codes: 0 = nothing to copy, 1 = copied OK, 2-7 = various benign
 * outcomes (skipped, mismatched, etc.). 8+ = real failure.
 */
interface RobocopyResult { ok: boolean; message?: string; exitCode?: number }

function robocopyMove(
  sourcePath: string,
  destPath: string,
  isDirectory: boolean,
): Promise<RobocopyResult> {
  return new Promise((resolve) => {
    // robocopy's API is awkward: it takes a SOURCE DIR, a DEST DIR,
    // and an optional filename. For files, pass source's parent as
    // source dir + the filename. For directories, source path IS the
    // source dir, and we /e to copy subtree. Destination dir must
    // exist or robocopy creates it.
    const args: string[] = [];
    if (isDirectory) {
      // Directory move: robocopy SRC_DIR DEST_DIR /move /e /b
      args.push(sourcePath, destPath, "/move", "/e", "/b");
    } else {
      // File move: robocopy SRC_PARENT DEST_PARENT FILENAME /move /b
      const srcParent = Path.dirname(sourcePath);
      const destParent = Path.dirname(destPath);
      const filename = Path.basename(sourcePath);
      args.push(srcParent, destParent, filename, "/move", "/b");
    }
    args.push(
      "/copy:DAT", "/r:1", "/w:1",
      "/njh", "/njs", "/ndl", "/nc", "/ns", "/np",
    );

    let stderrBuf = "";
    let stdoutBuf = "";
    logCrash("easy-move-robocopy", `spawn robocopy.exe args=${JSON.stringify(args)}`);
    try {
      const child = spawn("robocopy.exe", args, {
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
      child.stdout?.on("data", (chunk) => { stdoutBuf += String(chunk); });
      child.stderr?.on("data", (chunk) => { stderrBuf += String(chunk); });
      child.on("error", (err) => {
        logCrash("easy-move-robocopy", `spawn error: ${err.message}`);
        resolve({ ok: false, message: err.message });
      });
      child.on("exit", (code) => {
        logCrash(
          "easy-move-robocopy",
          `exit=${code} stdout-len=${stdoutBuf.length} stderr-len=${stderrBuf.length} stdout=${stdoutBuf.slice(0, 500).replace(/\r?\n/g, " | ")} stderr=${stderrBuf.slice(0, 500).replace(/\r?\n/g, " | ")}`,
        );
        // robocopy uses a BIT-FLAG exit model: codes 0-7 are success
        // (bits 1=copied, 2=extra files, 4=mismatched), 8+ are real
        // failures (8=copy errors, 16=fatal). Treat <8 as success.
        const exitCode = code ?? -1;
        if (exitCode >= 0 && exitCode < 8) {
          resolve({ ok: true, exitCode });
          return;
        }
        const errText = stderrBuf.trim() || stdoutBuf.trim() ||
          `robocopy exited with ${exitCode}`;
        resolve({
          ok: false,
          exitCode,
          message: errText.slice(0, 400),
        });
      });
    } catch (err) {
      resolve({
        ok: false,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  });
}
