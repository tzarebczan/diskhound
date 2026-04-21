import * as FSP from "node:fs/promises";
import * as Path from "node:path";
import * as OS from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  diffIndexes,
  indexFilePath,
  initScanIndex,
  loadIndex,
  openIndexWriter,
  type IndexRecord,
} from "../scanIndex";
import { normPath } from "../pathUtils";

let tempDir: string;

beforeEach(async () => {
  tempDir = await FSP.mkdtemp(Path.join(OS.tmpdir(), "diskhound-index-test-"));
  initScanIndex(tempDir);
});

afterEach(async () => {
  await FSP.rm(tempDir, { recursive: true, force: true });
});

function rec(p: string, s: number, m = 1000): IndexRecord {
  return { p, s, m };
}

function key(p: string): string {
  return normPath(p);
}

describe("scanIndex writer + loader round-trip", () => {
  it("writes and reads back entries correctly", async () => {
    const path = indexFilePath("test-round-trip");
    const { stream, finalize } = openIndexWriter(path);
    stream.write(JSON.stringify({ p: "C:\\a.txt", s: 100, m: 1000 }) + "\n");
    stream.write(JSON.stringify({ p: "C:\\b.dat", s: 200, m: 2000 }) + "\n");
    await finalize();

    const loaded = await loadIndex(path);
    expect(loaded.size).toBe(2);
    expect(loaded.get(key("C:\\a.txt"))?.s).toBe(100);
    expect(loaded.get(key("C:\\b.dat"))?.s).toBe(200);
  });

  it("loads empty map when file is missing", async () => {
    const loaded = await loadIndex(indexFilePath("does-not-exist"));
    expect(loaded.size).toBe(0);
  });

  it("skips malformed lines without crashing", async () => {
    const path = indexFilePath("malformed");
    const { stream, finalize } = openIndexWriter(path);
    stream.write(JSON.stringify({ p: "C:\\ok.txt", s: 100, m: 1 }) + "\n");
    stream.write("not json\n");
    stream.write(JSON.stringify({ p: "C:\\also-ok.txt", s: 200, m: 2 }) + "\n");
    await finalize();

    const loaded = await loadIndex(path);
    expect(loaded.size).toBe(2);
  });
});

describe("diffIndexes", () => {
  const baseline = new Map<string, IndexRecord>([
    [key("C:\\a.txt"), rec("C:\\a.txt", 100)],
    [key("C:\\b.dat"), rec("C:\\b.dat", 1000)],
    [key("C:\\c.log"), rec("C:\\c.log", 500)],
  ]);

  it("returns zero changes for identical indexes", () => {
    const result = diffIndexes("b", "c", baseline, new Map(baseline));
    expect(result.totalChanges).toBe(0);
    expect(result.changes).toHaveLength(0);
    expect(result.totalBytesAdded).toBe(0);
    expect(result.totalBytesRemoved).toBe(0);
  });

  it("detects added files", () => {
    const current = new Map(baseline);
    current.set(key("C:\\new.mp4"), rec("C:\\new.mp4", 5000));

    const result = diffIndexes("b", "c", baseline, current);
    expect(result.totalAdded).toBe(1);
    expect(result.totalBytesAdded).toBe(5000);
    expect(result.changes[0].kind).toBe("added");
    expect(result.changes[0].path).toBe("C:\\new.mp4");
    expect(result.changes[0].deltaBytes).toBe(5000);
  });

  it("detects removed files", () => {
    const current = new Map(baseline);
    current.delete(key("C:\\b.dat"));

    const result = diffIndexes("b", "c", baseline, current);
    expect(result.totalRemoved).toBe(1);
    expect(result.totalBytesRemoved).toBe(1000);
    expect(result.changes[0].kind).toBe("removed");
    expect(result.changes[0].deltaBytes).toBe(-1000);
  });

  it("detects grew files", () => {
    const current = new Map(baseline);
    current.set(key("C:\\b.dat"), rec("C:\\b.dat", 3000));

    const result = diffIndexes("b", "c", baseline, current);
    expect(result.totalGrew).toBe(1);
    expect(result.changes[0].kind).toBe("grew");
    expect(result.changes[0].deltaBytes).toBe(2000);
    expect(result.changes[0].previousSize).toBe(1000);
    expect(result.changes[0].size).toBe(3000);
  });

  it("detects shrank files", () => {
    const current = new Map(baseline);
    current.set(key("C:\\b.dat"), rec("C:\\b.dat", 200));

    const result = diffIndexes("b", "c", baseline, current);
    expect(result.totalShrank).toBe(1);
    expect(result.changes[0].kind).toBe("shrank");
    expect(result.changes[0].deltaBytes).toBe(-800);
  });

  it("sorts changes by absolute delta descending", () => {
    const current = new Map(baseline);
    current.set(key("C:\\a.txt"), rec("C:\\a.txt", 150)); // +50
    current.set(key("C:\\b.dat"), rec("C:\\b.dat", 500)); // -500
    current.set(key("C:\\new.bin"), rec("C:\\new.bin", 10000)); // +10000

    const result = diffIndexes("b", "c", baseline, current);
    expect(result.changes[0].path).toBe("C:\\new.bin");
    expect(Math.abs(result.changes[0].deltaBytes)).toBe(10000);
    expect(result.changes[1].path).toBe("C:\\b.dat");
  });

  it("caps results at the given limit and flags truncated", () => {
    const current = new Map<string, IndexRecord>();
    for (let i = 0; i < 100; i++) {
      current.set(key(`C:\\file-${i}.bin`), rec(`C:\\file-${i}.bin`, i + 1));
    }
    const result = diffIndexes("b", "c", new Map(), current, 10);
    expect(result.totalChanges).toBe(100);
    expect(result.changes).toHaveLength(10);
    expect(result.truncated).toBe(true);
  });

  it("does not flag truncated when everything fits", () => {
    const current = new Map(baseline);
    current.set(key("C:\\new.txt"), rec("C:\\new.txt", 50));
    const result = diffIndexes("b", "c", baseline, current, 100);
    expect(result.truncated).toBe(false);
  });

  it("handles full replacement (baseline empty)", () => {
    const current = new Map(baseline);
    const result = diffIndexes("b", "c", new Map(), current);
    expect(result.totalAdded).toBe(3);
    expect(result.totalRemoved).toBe(0);
  });

  it("handles deletion of everything (current empty)", () => {
    const result = diffIndexes("b", "c", baseline, new Map());
    expect(result.totalRemoved).toBe(3);
    expect(result.totalAdded).toBe(0);
    expect(result.totalBytesRemoved).toBe(1600);
  });
});
