import * as FS from "node:fs/promises";
import * as FS_SYNC from "node:fs";
import * as Path from "node:path";

import type { FullDiffResult } from "./contracts";

const FULL_DIFF_CACHE_DIR = "full-diff-cache";
const FULL_DIFF_CACHE_SUFFIX = ".json";

let fullDiffCacheDir = "";

export function initFullDiffCacheStore(dataDir: string): void {
  fullDiffCacheDir = Path.join(dataDir, FULL_DIFF_CACHE_DIR);
  try {
    FS_SYNC.mkdirSync(fullDiffCacheDir, { recursive: true });
  } catch {
    // best effort
  }
}

export function fullDiffCachePath(
  baselineId: string,
  currentId: string,
  limit: number,
): string {
  return Path.join(
    fullDiffCacheDir,
    `${baselineId}__${currentId}__${normalizeLimit(limit)}${FULL_DIFF_CACHE_SUFFIX}`,
  );
}

export async function readFullDiffCache(
  baselineId: string,
  currentId: string,
  limit: number,
): Promise<FullDiffResult | null> {
  try {
    const raw = await FS.readFile(fullDiffCachePath(baselineId, currentId, limit), "utf8");
    return JSON.parse(raw) as FullDiffResult;
  } catch {
    return null;
  }
}

export async function writeFullDiffCache(
  result: FullDiffResult,
  limit: number,
): Promise<void> {
  const filePath = fullDiffCachePath(result.baselineId, result.currentId, limit);
  const tempPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;

  try {
    await FS.mkdir(Path.dirname(filePath), { recursive: true });
    await FS.writeFile(tempPath, JSON.stringify(result), "utf8");
    await FS.rename(tempPath, filePath);
  } catch {
    try {
      await FS.unlink(tempPath);
    } catch {
      // ignore
    }
  }
}

export async function hasFullDiffCache(
  baselineId: string,
  currentId: string,
  limit: number,
): Promise<boolean> {
  try {
    await FS.access(fullDiffCachePath(baselineId, currentId, limit));
    return true;
  } catch {
    return false;
  }
}

export async function deleteFullDiffCachesForScan(scanId: string): Promise<void> {
  if (!fullDiffCacheDir) return;

  try {
    const entries = await FS.readdir(fullDiffCacheDir, { withFileTypes: true });
    await Promise.all(entries
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name)
      .filter((name) =>
        name.startsWith(`${scanId}__`) || name.includes(`__${scanId}__`),
      )
      .map((name) => FS.unlink(Path.join(fullDiffCacheDir, name)).catch(() => {})));
  } catch {
    // ignore
  }
}

function normalizeLimit(limit: number): number {
  if (!Number.isFinite(limit) || limit <= 0) return 500;
  return Math.max(0, Math.floor(limit));
}
