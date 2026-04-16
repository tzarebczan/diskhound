import * as FS from "node:fs";
import * as FSP from "node:fs/promises";
import * as Path from "node:path";
import { randomUUID } from "node:crypto";

import type { ScanHistoryEntry, ScanSnapshot } from "./contracts";
import { normPath } from "./pathUtils";

const INDEX_FILENAME = "scan-history-index.json";
const SNAPSHOT_PREFIX = "scan-";
const MAX_HISTORY_PER_ROOT = 20;

let historyDir = "";
let index: ScanHistoryEntry[] = [];

export function initScanHistory(dataDir: string): void {
  historyDir = Path.join(dataDir, "scan-history");
  index = [];
  try {
    FS.mkdirSync(historyDir, { recursive: true });
  } catch { /* exists */ }

  const indexPath = Path.join(historyDir, INDEX_FILENAME);
  try {
    if (FS.existsSync(indexPath)) {
      index = JSON.parse(FS.readFileSync(indexPath, "utf-8"));
    }
  } catch {
    index = [];
  }
}

function persistIndex(): void {
  if (!historyDir) return;
  try {
    FS.writeFileSync(
      Path.join(historyDir, INDEX_FILENAME),
      JSON.stringify(index, null, 2),
    );
  } catch { /* best effort */ }
}

function snapshotPath(id: string): string {
  return Path.join(historyDir, `${SNAPSHOT_PREFIX}${id}.json`);
}

/** Save a completed scan to history. Returns the history entry ID. */
export async function saveScanToHistory(snapshot: ScanSnapshot): Promise<string | null> {
  if (!historyDir || !snapshot.rootPath || snapshot.status !== "done") return null;

  const rootPath = snapshot.rootPath;
  const id = randomUUID();
  const entry: ScanHistoryEntry = {
    id,
    rootPath,
    scannedAt: snapshot.finishedAt ?? Date.now(),
    filesVisited: snapshot.filesVisited,
    directoriesVisited: snapshot.directoriesVisited,
    bytesSeen: snapshot.bytesSeen,
    elapsedMs: snapshot.elapsedMs,
  };

  // Write the full snapshot
  try {
    await FSP.writeFile(snapshotPath(id), JSON.stringify(snapshot), "utf-8");
  } catch {
    return null;
  }

  // Add to index
  index.push(entry);

  // Prune old entries for this root path
  const rootEntries = index
    .filter((e) => normPath(e.rootPath) === normPath(rootPath))
    .sort((a, b) => b.scannedAt - a.scannedAt);

  if (rootEntries.length > MAX_HISTORY_PER_ROOT) {
    const toRemove = rootEntries.slice(MAX_HISTORY_PER_ROOT);
    for (const old of toRemove) {
      index = index.filter((e) => e.id !== old.id);
      try { FS.unlinkSync(snapshotPath(old.id)); } catch { /* gone */ }
    }
  }

  persistIndex();
  return id;
}

/** Get history entries for a given root path, newest first. */
export function getScanHistory(rootPath: string): ScanHistoryEntry[] {
  return index
    .filter((e) => normPath(e.rootPath) === normPath(rootPath))
    .sort((a, b) => b.scannedAt - a.scannedAt);
}

/** Load a full snapshot from history by ID. */
export async function loadHistoricalSnapshot(id: string): Promise<ScanSnapshot | null> {
  const filePath = snapshotPath(id);
  try {
    const raw = await FSP.readFile(filePath, "utf-8");
    return JSON.parse(raw) as ScanSnapshot;
  } catch {
    return null;
  }
}

/** Get the two most recent entries for a root path (for "latest diff"). */
export function getLatestPair(rootPath: string): { current: ScanHistoryEntry; baseline: ScanHistoryEntry } | null {
  const entries = getScanHistory(rootPath);
  if (entries.length < 2) return null;
  return { current: entries[0], baseline: entries[1] };
}

