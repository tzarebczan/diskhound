import { describe, expect, it } from "vitest";

import { computeDiff } from "../scanDiff";
import { createIdleScanSnapshot, type ScanFileRecord, type ScanSnapshot } from "../contracts";
import { normPath } from "../pathUtils";

function makeSnapshot(overrides: Partial<ScanSnapshot> = {}): ScanSnapshot {
  return {
    ...createIdleScanSnapshot(),
    status: "done",
    rootPath: "C:\\test",
    startedAt: 1000,
    finishedAt: 2000,
    ...overrides,
  };
}

function makeFile(path: string, size: number, ext = ".bin"): ScanFileRecord {
  const name = path.split(/[\\/]/).pop() ?? path;
  return { path, name, parentPath: "C:\\test", extension: ext, size, modifiedAt: Date.now() };
}

describe("computeDiff", () => {
  it("returns zero deltas for identical snapshots", () => {
    const snap = makeSnapshot({ bytesSeen: 5000, filesVisited: 10, directoriesVisited: 3 });
    const diff = computeDiff(snap, snap, "base", "curr");

    expect(diff.totalBytesDelta).toBe(0);
    expect(diff.totalFilesDelta).toBe(0);
    expect(diff.totalDirsDelta).toBe(0);
    expect(diff.fileDeltas).toHaveLength(0);
    expect(diff.directoryDeltas).toHaveLength(0);
    expect(diff.extensionDeltas).toHaveLength(0);
  });

  it("computes aggregate deltas from bytesSeen/filesVisited/directoriesVisited", () => {
    const baseline = makeSnapshot({ bytesSeen: 1000, filesVisited: 10, directoriesVisited: 5 });
    const current = makeSnapshot({ bytesSeen: 3000, filesVisited: 15, directoriesVisited: 7 });
    const diff = computeDiff(baseline, current, "b", "c");

    expect(diff.totalBytesDelta).toBe(2000);
    expect(diff.totalFilesDelta).toBe(5);
    expect(diff.totalDirsDelta).toBe(2);
    expect(diff.previousBytesSeen).toBe(1000);
    expect(diff.currentBytesSeen).toBe(3000);
  });

  it("detects added files", () => {
    // Bump aggregates to match the itemized add. In real scans a file
    // appearing always moves both bytesSeen and filesVisited; the
    // "phantom add" filter in computeDiff kicks in only when aggregates
    // are untouched (which means the itemized entry is top-N churn,
    // not a real add).
    const baseline = makeSnapshot({ largestFiles: [], bytesSeen: 0, filesVisited: 0 });
    const current = makeSnapshot({
      largestFiles: [makeFile("C:\\test\\new.mp4", 5000)],
      bytesSeen: 5000,
      filesVisited: 1,
    });
    const diff = computeDiff(baseline, current, "b", "c");

    expect(diff.fileDeltas).toHaveLength(1);
    expect(diff.fileDeltas[0].kind).toBe("added");
    expect(diff.fileDeltas[0].size).toBe(5000);
    expect(diff.fileDeltas[0].previousSize).toBe(0);
    expect(diff.fileDeltas[0].deltaBytes).toBe(5000);
  });

  it("detects removed files", () => {
    const baseline = makeSnapshot({
      largestFiles: [makeFile("C:\\test\\old.log", 3000)],
      bytesSeen: 3000,
      filesVisited: 1,
    });
    const current = makeSnapshot({ largestFiles: [], bytesSeen: 0, filesVisited: 0 });
    const diff = computeDiff(baseline, current, "b", "c");

    expect(diff.fileDeltas).toHaveLength(1);
    expect(diff.fileDeltas[0].kind).toBe("removed");
    expect(diff.fileDeltas[0].size).toBe(0);
    expect(diff.fileDeltas[0].previousSize).toBe(3000);
    expect(diff.fileDeltas[0].deltaBytes).toBe(-3000);
  });

  it("suppresses top-N ranking churn when aggregates are unchanged", () => {
    // Regression: a directory falling off one snapshot's top-N cap
    // but still existing on disk used to appear as 'added' in the
    // current scan's directoryDeltas. With totalBytes/totalFiles
    // equal across both scans it's impossible for real adds/removes
    // to exist — filter them out so the Changes tab doesn't show
    // 9,999 phantom "ADDED" rows for genuinely-unchanged drives.
    const baseline = makeSnapshot({
      largestFiles: [makeFile("C:\\test\\a.bin", 1000)],
      bytesSeen: 1000,
      filesVisited: 1,
    });
    const current = makeSnapshot({
      largestFiles: [makeFile("C:\\test\\b.bin", 1000)],
      bytesSeen: 1000,
      filesVisited: 1,
    });
    const diff = computeDiff(baseline, current, "b", "c");

    expect(diff.totalBytesDelta).toBe(0);
    expect(diff.totalFilesDelta).toBe(0);
    // Would be 2 entries (1 removed + 1 added) without the filter.
    expect(diff.fileDeltas).toHaveLength(0);
  });

  it("detects files that grew", () => {
    const baseline = makeSnapshot({
      largestFiles: [makeFile("C:\\test\\data.db", 1000)],
    });
    const current = makeSnapshot({
      largestFiles: [makeFile("C:\\test\\data.db", 5000)],
    });
    const diff = computeDiff(baseline, current, "b", "c");

    expect(diff.fileDeltas).toHaveLength(1);
    expect(diff.fileDeltas[0].kind).toBe("grew");
    expect(diff.fileDeltas[0].deltaBytes).toBe(4000);
  });

  it("detects files that shrank", () => {
    const baseline = makeSnapshot({
      largestFiles: [makeFile("C:\\test\\data.db", 5000)],
    });
    const current = makeSnapshot({
      largestFiles: [makeFile("C:\\test\\data.db", 2000)],
    });
    const diff = computeDiff(baseline, current, "b", "c");

    expect(diff.fileDeltas).toHaveLength(1);
    expect(diff.fileDeltas[0].kind).toBe("shrank");
    expect(diff.fileDeltas[0].deltaBytes).toBe(-3000);
  });

  it("sorts deltas by absolute impact (largest first)", () => {
    const baseline = makeSnapshot({
      largestFiles: [
        makeFile("C:\\test\\small.txt", 100),
        makeFile("C:\\test\\big.zip", 10000),
      ],
    });
    const current = makeSnapshot({
      largestFiles: [
        makeFile("C:\\test\\small.txt", 200), // +100
        makeFile("C:\\test\\big.zip", 5000),  // -5000
      ],
    });
    const diff = computeDiff(baseline, current, "b", "c");

    expect(diff.fileDeltas).toHaveLength(2);
    expect(Math.abs(diff.fileDeltas[0].deltaBytes)).toBeGreaterThanOrEqual(
      Math.abs(diff.fileDeltas[1].deltaBytes),
    );
  });

  it("detects directory changes", () => {
    const baseline = makeSnapshot({
      hottestDirectories: [{ path: "C:\\test\\docs", size: 1000, fileCount: 5, depth: 1 }],
    });
    const current = makeSnapshot({
      hottestDirectories: [{ path: "C:\\test\\docs", size: 3000, fileCount: 8, depth: 1 }],
    });
    const diff = computeDiff(baseline, current, "b", "c");

    expect(diff.directoryDeltas).toHaveLength(1);
    expect(diff.directoryDeltas[0].kind).toBe("grew");
    expect(diff.directoryDeltas[0].deltaBytes).toBe(2000);
    expect(diff.directoryDeltas[0].fileCount).toBe(8);
    expect(diff.directoryDeltas[0].previousFileCount).toBe(5);
  });

  it("detects extension changes", () => {
    const baseline = makeSnapshot({
      topExtensions: [{ extension: ".mp4", size: 5000, count: 2 }],
    });
    const current = makeSnapshot({
      topExtensions: [{ extension: ".mp4", size: 8000, count: 3 }],
    });
    const diff = computeDiff(baseline, current, "b", "c");

    expect(diff.extensionDeltas).toHaveLength(1);
    expect(diff.extensionDeltas[0].deltaBytes).toBe(3000);
    expect(diff.extensionDeltas[0].count).toBe(3);
    expect(diff.extensionDeltas[0].previousCount).toBe(2);
  });

  it("matches file paths using platform normalization rules", () => {
    const baseline = makeSnapshot({
      largestFiles: [makeFile("C:\\Test\\FILE.TXT", 1000)],
    });
    const current = makeSnapshot({
      largestFiles: [makeFile("C:\\test\\file.txt", 2000)],
    });
    const diff = computeDiff(baseline, current, "b", "c");

    if (normPath("C:\\Test\\FILE.TXT") === normPath("C:\\test\\file.txt")) {
      expect(diff.fileDeltas).toHaveLength(1);
      expect(diff.fileDeltas[0].kind).toBe("grew");
      return;
    }

    expect(diff.fileDeltas).toHaveLength(2);
    expect(diff.fileDeltas.map((delta) => delta.kind).sort()).toEqual(["added", "removed"]);
  });

  it("computes timeBetweenMs from finishedAt timestamps", () => {
    const baseline = makeSnapshot({ finishedAt: 1000 });
    const current = makeSnapshot({ finishedAt: 5000 });
    const diff = computeDiff(baseline, current, "b", "c");

    expect(diff.timeBetweenMs).toBe(4000);
  });

  it("ignores files that exist in both with identical size", () => {
    const file = makeFile("C:\\test\\stable.bin", 999);
    const baseline = makeSnapshot({ largestFiles: [file] });
    const current = makeSnapshot({ largestFiles: [file] });
    const diff = computeDiff(baseline, current, "b", "c");

    expect(diff.fileDeltas).toHaveLength(0);
  });
});
