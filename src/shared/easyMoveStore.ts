import * as FS from "node:fs";
import * as FSP from "node:fs/promises";
import * as Path from "node:path";
import { randomUUID } from "node:crypto";
import { execSync } from "node:child_process";

import type { EasyMoveRecord, EasyMoveResult, PathActionResult } from "./contracts";

const STORE_FILENAME = "easy-moves.json";

let dataDir = "";
let records: EasyMoveRecord[] = [];

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
  try {
    // [P1] Guard: destination must not be inside the source tree
    if (isInsideOrEqual(destinationDir, sourcePath)) {
      return {
        ok: false,
        message: "Cannot move into a subfolder of the source — that would create a recursive loop.",
      };
    }

    // Validate source exists
    const stat = await FSP.stat(sourcePath);
    const isDirectory = stat.isDirectory();
    const size = stat.size;

    // Build destination path
    const baseName = Path.basename(sourcePath);
    const destPath = Path.join(destinationDir, baseName);

    // Check destination doesn't already exist
    if (FS.existsSync(destPath)) {
      return { ok: false, message: `Destination already exists: ${destPath}` };
    }

    // Ensure destination directory exists
    await FSP.mkdir(destinationDir, { recursive: true });

    // Move the file/folder
    try {
      await FSP.rename(sourcePath, destPath);
    } catch {
      // rename fails across drives — fall back to copy + delete
      if (isDirectory) {
        await copyDirRecursive(sourcePath, destPath);
        await FSP.rm(sourcePath, { recursive: true, force: true });
      } else {
        await FSP.copyFile(sourcePath, destPath);
        await FSP.unlink(sourcePath);
      }
    }

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
    return {
      ok: false,
      message: error instanceof Error ? error.message : String(error),
    };
  }
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
