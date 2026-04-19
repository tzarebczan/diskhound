import * as FS from "node:fs";
import * as FSP from "node:fs/promises";
import * as Path from "node:path";

/**
 * Persisted USN-journal cursor for a single NTFS volume. When present, the
 * monitor can do an *incremental* scan that just reads journal records
 * since the cursor, instead of walking the full tree.
 *
 * Invariants:
 * - `journalId` must match the volume's current journal. If the journal is
 *   recreated (disabled+enabled, or reformat), the ID changes and any stored
 *   cursor is invalid — we detect that in the reader and fall back to full.
 * - `cursor` must be >= the volume's `firstUsn`. If it isn't, the journal
 *   has wrapped past our saved point; older events are lost, full rescan
 *   required.
 * - `rootPath` records which scan root the cursor was captured for. If the
 *   user triggers a scan on a different root on the same volume, we can
 *   still reuse the cursor (the journal applies to the whole volume), but
 *   we keep this field for debugging.
 */
export interface VolumeCursor {
  /** Drive letter + colon, always uppercase — e.g. "C:" */
  volume: string;
  /** Last USN we processed. Next incremental read starts here. */
  cursor: number;
  /** USN journal instance ID. If this ever differs from the current one,
   *  the cursor is stale. */
  journalId: number;
  /** Epoch ms when this cursor was captured. */
  capturedAt: number;
  /** Scan root associated with this cursor (informational). */
  rootPath: string;
}

const FILE_NAME = "usn-cursors.json";

interface PersistedState {
  cursors: Record<string, VolumeCursor>;
}

let persistDir: string | null = null;
let cache: Map<string, VolumeCursor> = new Map();

export async function initUsnCursorStore(dataDir: string): Promise<void> {
  persistDir = dataDir;
  cache = new Map();

  const path = Path.join(dataDir, FILE_NAME);
  try {
    const raw = await FSP.readFile(path, "utf8");
    const state = JSON.parse(raw) as PersistedState;
    if (state && typeof state.cursors === "object" && state.cursors) {
      for (const [key, value] of Object.entries(state.cursors)) {
        if (isValidCursor(value)) {
          cache.set(normalizeVolume(key), value);
        }
      }
    }
  } catch {
    // Missing file or corrupt JSON — start fresh. We'll just fall back to
    // full scans until the next scan captures a cursor.
  }
}

function isValidCursor(value: unknown): value is VolumeCursor {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.volume === "string" &&
    typeof v.cursor === "number" &&
    typeof v.journalId === "number" &&
    typeof v.capturedAt === "number" &&
    typeof v.rootPath === "string"
  );
}

async function persist(): Promise<void> {
  if (!persistDir) return;
  const state: PersistedState = {
    cursors: Object.fromEntries(cache),
  };
  try {
    await FSP.mkdir(persistDir, { recursive: true });
    await FSP.writeFile(
      Path.join(persistDir, FILE_NAME),
      JSON.stringify(state, null, 2),
      "utf8",
    );
  } catch {
    // Non-fatal — we'll re-capture the cursor on the next full scan.
  }
}

/** Normalize "c" | "C:" | "C:\\" → "C:" for cache keys. */
export function normalizeVolume(value: string): string {
  const trimmed = value.replace(/[\\/]+$/, "").replace(/:$/, "");
  const letter = trimmed.charAt(0).toUpperCase();
  return letter ? `${letter}:` : "";
}

/** Derive the volume for a root path like "C:\\Users\\foo" → "C:". */
export function volumeForPath(rootPath: string): string {
  return normalizeVolume(rootPath);
}

export function getCursor(volume: string): VolumeCursor | null {
  return cache.get(normalizeVolume(volume)) ?? null;
}

export async function setCursor(entry: VolumeCursor): Promise<void> {
  const key = normalizeVolume(entry.volume);
  if (!key) return;
  cache.set(key, { ...entry, volume: key });
  await persist();
}

export async function invalidateVolume(volume: string): Promise<void> {
  const key = normalizeVolume(volume);
  if (cache.delete(key)) {
    await persist();
  }
}

/** Export everything (for diagnostics UI if we want to show users). */
export function listCursors(): VolumeCursor[] {
  return Array.from(cache.values());
}

/** Exported for tests — only use from test code. */
export function __resetStoreForTests(): void {
  persistDir = null;
  cache = new Map();
}

// Re-export sync FS existence check for test convenience
export const _FS = FS;
