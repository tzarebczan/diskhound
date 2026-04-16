import * as FS from "node:fs";
import * as FSP from "node:fs/promises";
import * as Path from "node:path";
import * as OS from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  getScanHistory,
  getLatestPair,
  initScanHistory,
  loadHistoricalSnapshot,
  saveScanToHistory,
} from "../scanHistory";
import { createIdleScanSnapshot, type ScanSnapshot } from "../contracts";

let tempDir: string;

function makeSnapshot(rootPath: string, bytesSeen: number, finishedAt: number): ScanSnapshot {
  return {
    ...createIdleScanSnapshot(),
    status: "done",
    rootPath,
    bytesSeen,
    filesVisited: 100,
    directoriesVisited: 10,
    startedAt: finishedAt - 1000,
    finishedAt,
    elapsedMs: 1000,
  };
}

beforeEach(async () => {
  tempDir = await FSP.mkdtemp(Path.join(OS.tmpdir(), "diskhound-test-"));
  initScanHistory(tempDir);
});

afterEach(async () => {
  await FSP.rm(tempDir, { recursive: true, force: true });
});

describe("scanHistory", () => {
  it("creates the history directory on init", () => {
    expect(FS.existsSync(Path.join(tempDir, "scan-history"))).toBe(true);
  });

  it("saves a snapshot and returns it in history", async () => {
    const snap = makeSnapshot("C:\\test", 5000, Date.now());
    const id = await saveScanToHistory(snap);

    expect(id).toBeTruthy();

    const history = getScanHistory("C:\\test");
    expect(history).toHaveLength(1);
    expect(history[0].rootPath).toBe("C:\\test");
    expect(history[0].bytesSeen).toBe(5000);
  });

  it("returns history entries sorted newest-first", async () => {
    const now = Date.now();
    await saveScanToHistory(makeSnapshot("C:\\test", 1000, now - 3000));
    await saveScanToHistory(makeSnapshot("C:\\test", 2000, now - 2000));
    await saveScanToHistory(makeSnapshot("C:\\test", 3000, now - 1000));

    const history = getScanHistory("C:\\test");
    expect(history).toHaveLength(3);
    expect(history[0].bytesSeen).toBe(3000); // newest
    expect(history[2].bytesSeen).toBe(1000); // oldest
  });

  it("loads a full snapshot by ID", async () => {
    const snap = makeSnapshot("C:\\test", 7777, Date.now());
    const id = await saveScanToHistory(snap);

    const loaded = await loadHistoricalSnapshot(id!);
    expect(loaded).not.toBeNull();
    expect(loaded!.bytesSeen).toBe(7777);
    expect(loaded!.rootPath).toBe("C:\\test");
  });

  it("returns null for non-existent snapshot ID", async () => {
    const loaded = await loadHistoricalSnapshot("non-existent-id");
    expect(loaded).toBeNull();
  });

  it("getLatestPair returns the two most recent entries", async () => {
    const now = Date.now();
    await saveScanToHistory(makeSnapshot("C:\\test", 1000, now - 2000));
    await saveScanToHistory(makeSnapshot("C:\\test", 2000, now - 1000));
    await saveScanToHistory(makeSnapshot("C:\\test", 3000, now));

    const pair = getLatestPair("C:\\test");
    expect(pair).not.toBeNull();
    expect(pair!.current.bytesSeen).toBe(3000);
    expect(pair!.baseline.bytesSeen).toBe(2000);
  });

  it("getLatestPair returns null with fewer than 2 entries", async () => {
    await saveScanToHistory(makeSnapshot("C:\\test", 1000, Date.now()));
    expect(getLatestPair("C:\\test")).toBeNull();
  });

  it("only returns history for the matching root path", async () => {
    await saveScanToHistory(makeSnapshot("C:\\path-a", 1000, Date.now()));
    await saveScanToHistory(makeSnapshot("C:\\path-b", 2000, Date.now()));

    expect(getScanHistory("C:\\path-a")).toHaveLength(1);
    expect(getScanHistory("C:\\path-b")).toHaveLength(1);
    expect(getScanHistory("C:\\path-c")).toHaveLength(0);
  });

  it("does not save non-done snapshots", async () => {
    const running = makeSnapshot("C:\\test", 5000, Date.now());
    running.status = "running";
    const id = await saveScanToHistory(running);

    expect(id).toBeNull();
    expect(getScanHistory("C:\\test")).toHaveLength(0);
  });

  it("prunes old entries beyond the limit", async () => {
    const now = Date.now();
    // Save 22 entries (limit is 20)
    for (let i = 0; i < 22; i++) {
      await saveScanToHistory(makeSnapshot("C:\\test", i * 100, now + i));
    }

    const history = getScanHistory("C:\\test");
    expect(history.length).toBeLessThanOrEqual(20);
  });

  it("handles re-init with existing data", async () => {
    await saveScanToHistory(makeSnapshot("C:\\test", 5000, Date.now()));

    // Re-init from the same directory (simulating app restart)
    initScanHistory(tempDir);

    const history = getScanHistory("C:\\test");
    expect(history).toHaveLength(1);
    expect(history[0].bytesSeen).toBe(5000);
  });
});
