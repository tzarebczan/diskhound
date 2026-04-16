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
        current = parsed;
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
      await FSP.writeFile(filePath, JSON.stringify(snapshot), "utf-8");
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
