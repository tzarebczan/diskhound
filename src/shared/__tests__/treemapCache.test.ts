import * as FSP from "node:fs/promises";
import * as OS from "node:os";
import * as Path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { openIndexWriter, type IndexRecord } from "../scanIndex";
import { createTreemapCache } from "../treemapCache";

let tempDir: string;

beforeEach(async () => {
  tempDir = await FSP.mkdtemp(Path.join(OS.tmpdir(), "diskhound-treemap-cache-test-"));
});

afterEach(async () => {
  await FSP.rm(tempDir, { recursive: true, force: true });
});

function rec(p: string, s: number, m = 1000): IndexRecord {
  return { p, s, m };
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("treemapCache", () => {
  it("caches repeated loads for the same scan + limit", async () => {
    const loader = vi.fn(async () => [
      rec(Path.join(tempDir, "alpha.bin"), 400),
      rec(Path.join(tempDir, "beta.bin"), 200),
    ]);
    const cache = createTreemapCache({ loadLargestFiles: loader });

    const first = await cache.getOrLoad({
      scanId: "scan-1",
      indexPath: Path.join(tempDir, "scan-1.ndjson.gz"),
      limit: 500,
    });
    const second = await cache.getOrLoad({
      scanId: "scan-1",
      indexPath: Path.join(tempDir, "scan-1.ndjson.gz"),
      limit: 500,
    });

    expect(loader).toHaveBeenCalledTimes(1);
    expect(second).toEqual(first);
    expect(first[0]).toMatchObject({
      name: "alpha.bin",
      extension: ".bin",
      size: 400,
    });
  });

  it("dedupes concurrent in-flight loads for the same cache key", async () => {
    const gate = deferred<IndexRecord[]>();
    const loader = vi.fn(() => gate.promise);
    const cache = createTreemapCache({ loadLargestFiles: loader });

    const first = cache.getOrLoad({
      scanId: "scan-1",
      indexPath: Path.join(tempDir, "scan-1.ndjson.gz"),
    });
    const second = cache.getOrLoad({
      scanId: "scan-1",
      indexPath: Path.join(tempDir, "scan-1.ndjson.gz"),
    });

    expect(loader).toHaveBeenCalledTimes(1);
    gate.resolve([rec(Path.join(tempDir, "gamma.iso"), 900)]);

    const [firstResult, secondResult] = await Promise.all([first, second]);
    expect(firstResult).toEqual(secondResult);
    expect(cache.getStats().inflight).toBe(0);
  });

  it("does not repopulate cache entries that were invalidated mid-flight", async () => {
    const gate = deferred<IndexRecord[]>();
    const loader = vi.fn(() => gate.promise);
    const cache = createTreemapCache({ loadLargestFiles: loader });

    const pending = cache.getOrLoad({
      scanId: "scan-1",
      indexPath: Path.join(tempDir, "scan-1.ndjson.gz"),
    });

    cache.invalidateScan("scan-1");
    gate.resolve([rec(Path.join(tempDir, "delta.vhdx"), 2_000)]);

    await expect(pending).resolves.toHaveLength(1);
    expect(cache.peek({ scanId: "scan-1" })).toBeUndefined();
  });

  it("evicts prior scan entries when a newer scan becomes latest for the same root", async () => {
    const loader = vi.fn(async (indexPath: string) => {
      const name = Path.basename(indexPath, Path.extname(indexPath));
      return [rec(Path.join(tempDir, `${name}.bin`), 100)];
    });
    const cache = createTreemapCache({ loadLargestFiles: loader });

    cache.rememberLatest("C:\\", "scan-old");
    await cache.getOrLoad({
      scanId: "scan-old",
      rootPath: "C:\\",
      indexPath: Path.join(tempDir, "scan-old.ndjson.gz"),
    });
    expect(cache.peek({ scanId: "scan-old" })).toHaveLength(1);

    cache.rememberLatest("C:\\", "scan-new");

    expect(cache.peek({ scanId: "scan-old" })).toBeUndefined();
    expect(cache.getStats().rootsTracked).toBe(1);
  });

  it("supports explicit scan invalidation across multiple limits", async () => {
    const loader = vi.fn(async () => [rec(Path.join(tempDir, "epsilon.mkv"), 4_000)]);
    const cache = createTreemapCache({ loadLargestFiles: loader });

    await cache.getOrLoad({
      scanId: "scan-1",
      indexPath: Path.join(tempDir, "scan-1.ndjson.gz"),
      limit: 25,
    });
    await cache.getOrLoad({
      scanId: "scan-1",
      indexPath: Path.join(tempDir, "scan-1.ndjson.gz"),
      limit: 50,
    });

    expect(cache.getStats().entries).toBe(2);
    cache.invalidateScan("scan-1");
    expect(cache.peek({ scanId: "scan-1", limit: 25 })).toBeUndefined();
    expect(cache.peek({ scanId: "scan-1", limit: 50 })).toBeUndefined();
    expect(cache.getStats().entries).toBe(0);
  });

  it("bounds memory with an LRU cap", async () => {
    const loader = vi.fn(async (indexPath: string) => [
      rec(Path.join(tempDir, `${Path.basename(indexPath, Path.extname(indexPath))}.zip`), 50),
    ]);
    const cache = createTreemapCache({ loadLargestFiles: loader, maxEntries: 2 });

    await cache.getOrLoad({
      scanId: "scan-1",
      indexPath: Path.join(tempDir, "scan-1.ndjson.gz"),
    });
    await cache.getOrLoad({
      scanId: "scan-2",
      indexPath: Path.join(tempDir, "scan-2.ndjson.gz"),
    });
    await cache.getOrLoad({
      scanId: "scan-3",
      indexPath: Path.join(tempDir, "scan-3.ndjson.gz"),
    });

    expect(cache.peek({ scanId: "scan-1" })).toBeUndefined();
    expect(cache.peek({ scanId: "scan-2" })).toHaveLength(1);
    expect(cache.peek({ scanId: "scan-3" })).toHaveLength(1);
  });

  it("maps real index records into ScanFileRecord shape using the default loader", async () => {
    const indexPath = Path.join(tempDir, "real-index.ndjson.gz");
    const indexedFilePath = Path.join(tempDir, "Folder", "Bar.TXT");
    const { stream, finalize } = openIndexWriter(indexPath);
    stream.write(JSON.stringify({ p: indexedFilePath, s: 321, m: 456 }) + "\n");
    await finalize();

    const cache = createTreemapCache();
    const result = await cache.getOrLoad({
      scanId: "scan-real",
      indexPath,
      limit: 10,
    });

    expect(result).toEqual([
      {
        path: indexedFilePath,
        name: "Bar.TXT",
        parentPath: Path.dirname(indexedFilePath),
        extension: ".txt",
        size: 321,
        modifiedAt: 456,
      },
    ]);
  });
});
