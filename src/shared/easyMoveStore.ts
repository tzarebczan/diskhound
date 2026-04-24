import * as FS from "node:fs";
import * as FSP from "node:fs/promises";
import * as Path from "node:path";
import { randomUUID } from "node:crypto";
import { execSync, spawn } from "node:child_process";

import type {
  EasyMoveRecord,
  EasyMoveResult,
  EasyMoveStatus,
  EasyMoveVerification,
  PathActionResult,
} from "./contracts";

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

/**
 * Optional progress hook for long-running copies. main.ts wires this
 * to an IPC broadcast so the renderer can surface a progress toast or
 * status line. Fires at most every 500 ms per operation; noop default
 * means unit tests and non-Electron callers don't need to set it.
 */
export interface EasyMoveProgress {
  sourcePath: string;
  destinationPath: string;
  bytesCopied: number;
  bytesTotal: number;
  phase: "copying" | "linking" | "done";
}
type ProgressFn = (p: EasyMoveProgress) => void;
let emitProgress: ProgressFn = () => { /* noop */ };

export function setEasyMoveProgress(fn: ProgressFn): void {
  emitProgress = fn;
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
 * Verify an easy-move record's current on-disk state. Returns a
 * status code per record so the UI can show link-missing / dest-
 * missing badges next to each move and offer a repair action.
 *
 * Status meanings:
 *   - "ok"            : source is a link/junction, dest file exists
 *   - "link-missing"  : dest exists but source has no reparse point
 *                       (file was moved, link was never created or
 *                       was deleted externally)
 *   - "dest-missing"  : link at source exists but the target file
 *                       it points to is gone
 *   - "both-missing"  : both ends are gone (user deleted everything)
 *   - "source-file"   : source exists as a regular file (not a
 *                       link) AND dest also exists — double file
 *                       state, user intervention needed
 */
export async function verifyEasyMoves(): Promise<EasyMoveVerification[]> {
  const results: EasyMoveVerification[] = [];
  for (const rec of records) {
    // lstat (not stat) so symlinks don't transparently deref into
    // the target's metadata — we specifically want "is there a
    // reparse point at this path?".
    const srcLstat = await FSP.lstat(rec.symlinkPath).catch(() => null);
    const destStat = await FSP.stat(rec.movedToPath).catch(() => null);

    const sourceExists = srcLstat !== null;
    const destExists = destStat !== null;
    const sourceIsLink = srcLstat
      ? srcLstat.isSymbolicLink() ||
        // Windows junctions: lstat reports isDirectory=true AND
        // sets the reparse-point attribute. Node's Stats doesn't
        // expose attrs directly, but isSymbolicLink() covers most
        // Windows symlinks + junctions in recent Node versions.
        // Fall back to checking "size=0 and isDirectory" as a
        // heuristic for junctions.
        (process.platform === "win32" && srcLstat.isDirectory() && srcLstat.size === 0)
      : false;

    let status: EasyMoveStatus;
    if (!sourceExists && !destExists) status = "both-missing";
    else if (!destExists) status = "dest-missing";
    else if (!sourceExists) status = "link-missing";
    else if (!sourceIsLink) status = "source-file";
    else status = "ok";

    results.push({
      id: rec.id,
      status,
      sourceExists,
      sourceIsLink,
      destExists,
      destSize: destStat?.size ?? 0,
    });
  }
  return results;
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

    // Ensure destination directory exists. We guard the mkdir with an
    // existsSync check because Node's fs.mkdir with { recursive: true }
    // throws `EPERM: operation not permitted, mkdir 'E:\'` on Windows
    // drive roots — it calls CreateDirectoryW for each path component,
    // and Windows rejects creating a drive letter even when it already
    // exists. (Known Node quirk; see nodejs/node#43831.) Users hitting
    // this thought EasyMove was broken ("Couldn't access headers, EPERM")
    // when the actual root cause was the drive-root destination — not
    // the source file at all.
    if (!FS.existsSync(destinationDir)) {
      await FSP.mkdir(destinationDir, { recursive: true });
    } else {
      logCrash("easy-move", `dest dir already exists, skipping mkdir: ${destinationDir}`);
    }

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
            // Stream-based copy with progress so large cross-drive
            // moves don't feel frozen. Fires onProgress every
            // ~500 ms; caller hooks that up to crash.log + UI via
            // setEasyMoveProgress.
            await streamCopyWithProgress(sourcePath, destPath, size);
            await FSP.unlink(sourcePath);
          }
          moveSucceeded = true;
          logCrash("easy-move", `copy+unlink fallback succeeded`);
        } catch (copyErr) {
          lastMoveError = copyErr;
          logCrash(
            "easy-move",
            `copy+unlink fallback failed: ${copyErr instanceof Error ? copyErr.message : String(copyErr)}`,
          );
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
    const syscall = (error as NodeJS.ErrnoException)?.syscall;
    const errPath = (error as NodeJS.ErrnoException)?.path;
    if (code === "EPERM" || code === "EACCES" || code === "EBUSY") {
      const name = Path.basename(sourcePath);
      // Dispatch on the syscall that failed so we don't lie about the
      // cause. Previously every EPERM/EACCES was blamed on "another
      // process holding the source file open" — but the error might
      // be from mkdir on a drive root, from opendir on the destination,
      // etc. Node populates `syscall` on ErrnoException for exactly
      // this kind of dispatching.
      if (syscall === "mkdir" && errPath) {
        return {
          ok: false,
          message:
            `Can't create destination folder '${errPath}' (${code}). ` +
            `If you picked a drive root (like E:\\), pick a subfolder inside it instead — ` +
            `Windows won't let us "create" a drive letter even when it exists.`,
        };
      }
      if (syscall === "mkdir") {
        return {
          ok: false,
          message: `Can't create destination folder (${code}): ${(error instanceof Error ? error.message : String(error))}`,
        };
      }
      // Probe the current elevation state for source-side permission
      // errors. Non-elevated users get the UAC retry; elevated get a
      // "locked" message with actionable suggestions.
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
          `Couldn't ${syscall ?? "access"} ${name} (${code}). ` +
          `Another process is likely holding the file open — common culprits: ` +
          `WSL (for .vhdx), Hyper-V, Windows Defender, OneDrive sync, or an antivirus scan. ` +
          `Close the app using it or wait a moment and try again. ` +
          `Full error: ${error instanceof Error ? error.message : String(error)}`,
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
  let method = "unknown";
  if (process.platform === "win32") {
    if (isDirectory) {
      // Junction — no admin required. Works same-volume only but
      // that's rarely a limit for user-chosen destinations.
      await FSP.symlink(target, linkPath, "junction");
      method = "junction";
    } else {
      // Three-tier fallback for files. Each tier throws on failure
      // so we move to the next; the OUTER catch in easyMove handles
      // total failure. CRITICAL: prior versions swallowed each
      // failure and returned "success" even when no link was
      // actually created (observed: Ubuntu VHDX moved but source
      // missing, no link, easy-moves.json thought it was fine).
      // We now explicitly track which method succeeded and
      // lstat-verify at the end.
      let symlinkErr: unknown = null;
      let mklinkErr: unknown = null;
      try {
        await FSP.symlink(target, linkPath, "file");
        method = "symlink";
      } catch (err) {
        symlinkErr = err;
        try {
          execSync(
            `mklink "${linkPath}" "${target}"`,
            { stdio: "ignore", windowsHide: true },
          );
          method = "mklink";
        } catch (err2) {
          mklinkErr = err2;
          // Hardlink only works same-volume. Moving across drives
          // (C: → E:) guarantees this FAILS with EXDEV — at which
          // point the user is going to get an error, which is what
          // we want (better than silently returning "success" on
          // a non-existent link).
          try {
            await FSP.link(target, linkPath);
            method = "hardlink";
          } catch (err3) {
            throw new Error(
              `Couldn't create any link at ${linkPath}. ` +
              `symlink: ${symlinkErr instanceof Error ? symlinkErr.message : String(symlinkErr)}; ` +
              `mklink: ${mklinkErr instanceof Error ? mklinkErr.message : String(mklinkErr)}; ` +
              `hardlink: ${err3 instanceof Error ? err3.message : String(err3)}`,
            );
          }
        }
      }
    }
  } else {
    // macOS / Linux — standard symlinks
    await FSP.symlink(target, linkPath, isDirectory ? "dir" : "file");
    method = "symlink";
  }

  // Post-creation verification. Any of the above methods could
  // technically return without throwing yet leave no entry on disk
  // (Defender quarantine races, Dev Mode misconfiguration, etc.).
  // If lstat can't see something at linkPath, treat the creation
  // as failed so the caller can roll back the move.
  try {
    const ls = await FSP.lstat(linkPath);
    const isLink =
      ls.isSymbolicLink() ||
      // Windows junctions show as directories to lstat; check the
      // reparse-point attribute bit instead. On non-Windows, a
      // symlink always reports isSymbolicLink.
      (process.platform === "win32" &&
        (ls as unknown as { isReparsePoint?: boolean }).isReparsePoint === true);
    logCrash(
      "easy-move-link",
      `method=${method} linkPath=${linkPath} lstat: ` +
      `size=${ls.size} isDir=${ls.isDirectory()} isSymlink=${ls.isSymbolicLink()} ` +
      `hardlink=${method === "hardlink"} verified=${isLink || method === "hardlink"}`,
    );
  } catch (err) {
    throw new Error(
      `Link creation reported success via '${method}' but lstat(${linkPath}) ` +
      `fails: ${err instanceof Error ? err.message : String(err)}. ` +
      `Treating as link-creation failure so the move can be rolled back.`,
    );
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

/**
 * Stream-based copy with periodic progress callbacks. Replaces plain
 * FSP.copyFile for the cross-drive fallback path — on multi-GB files
 * that takes tens of seconds, and without progress the UI looks
 * frozen. Progress events fire at most every 500 ms to cap the IPC
 * traffic; at 1 GB/s SSD throughput that's one event per ~500 MB,
 * well within any reasonable UI refresh rate.
 */
async function streamCopyWithProgress(
  src: string,
  dest: string,
  sizeTotal: number,
): Promise<void> {
  const readStream = FS.createReadStream(src);
  const writeStream = FS.createWriteStream(dest);
  let bytesCopied = 0;
  let lastEmitAt = Date.now();

  return await new Promise<void>((resolve, reject) => {
    let settled = false;
    const settle = (err?: Error) => {
      if (settled) return;
      settled = true;
      // Always fire a final progress with phase=done so the UI can
      // dismiss its progress indicator and the crash log has a
      // closing line.
      emitProgress({
        sourcePath: src,
        destinationPath: dest,
        bytesCopied,
        bytesTotal: sizeTotal,
        phase: "done",
      });
      if (err) reject(err);
      else resolve();
    };

    readStream.on("error", settle);
    writeStream.on("error", settle);
    writeStream.on("finish", () => settle());

    readStream.on("data", (chunk) => {
      bytesCopied += chunk.length;
      const now = Date.now();
      if (now - lastEmitAt >= 500) {
        lastEmitAt = now;
        emitProgress({
          sourcePath: src,
          destinationPath: dest,
          bytesCopied,
          bytesTotal: sizeTotal,
          phase: "copying",
        });
      }
    });
    readStream.pipe(writeStream);
  });
}
