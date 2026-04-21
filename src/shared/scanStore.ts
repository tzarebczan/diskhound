import * as FS from "node:fs";
import * as FSP from "node:fs/promises";
import * as Path from "node:path";

import { createIdleScanSnapshot, type ScanSnapshot } from "./contracts";

const STORE_FILENAME = "last-scan.json";

export interface ScanSnapshotStore {
  get: () => Promise<ScanSnapshot>;
  set: (nextSnapshot: ScanSnapshot) => Promise<void>;
  update: (transform: (current: ScanSnapshot) => ScanSnapshot) => Promise<ScanSnapshot>;
}

/**
 * Defensive floor for `directoriesVisited` on rehydrated snapshots.
 *
 * Older versions wrote snapshots whose directoriesVisited was computed
 * from explicit `{t:"d"}` entries in the index; if the USN-journal
 * incremental path skipped those entries, the saved value collapsed to
 * 0 or 1 even on drives with thousands of directories. v0.3.7 tracks
 * every ancestor during the file walk as a new fallback, but stale
 * last-scan.json files from earlier versions still carry the bogus
 * value. We patch over those on read by flooring to
 * hottestDirectories.length, which is always a truthful lower bound
 * (it's capped at TOP_DIRECTORY_LIMIT but that's fine — a floor of
 * 10k is much more useful than "1").
 */
function floorDirectoriesVisited(snapshot: ScanSnapshot): ScanSnapshot {
  const floor = snapshot.hottestDirectories?.length ?? 0;
  if (floor > snapshot.directoriesVisited) {
    return { ...snapshot, directoriesVisited: floor };
  }
  return snapshot;
}

export async function createScanSnapshotStore(dataDir: string): Promise<ScanSnapshotStore> {
  const filePath = Path.join(dataDir, STORE_FILENAME);
  let current = createIdleScanSnapshot();

  // Rehydrate the last scan from disk
  try {
    if (FS.existsSync(filePath)) {
      const raw = await FSP.readFile(filePath, "utf-8");
      const parsed = JSON.parse(raw) as ScanSnapshot;
      // Only restore completed scans (not stale "running" snapshots)
      if (parsed && parsed.status === "done") {
        current = floorDirectoriesVisited(parsed);
      }
    }
  } catch {
    // Corrupt file — start fresh
  }

  const persist = async (snapshot: ScanSnapshot) => {
    // Only persist completed scans — no point saving running/idle/error
    if (snapshot.status !== "done") return;
    try {
      await FSP.mkdir(dataDir, { recursive: true });
      await FSP.writeFile(filePath, JSON.stringify(floorDirectoriesVisited(snapshot)), "utf-8");
    } catch {
      // Best effort — don't block the scan pipeline
    }
  };

  return {
    get: async () => current,
    set: async (nextSnapshot) => {
      current = nextSnapshot;
      await persist(current);
    },
    update: async (transform) => {
      current = transform(current);
      await persist(current);
      return current;
    },
  };
}
