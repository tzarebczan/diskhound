import * as FSP from "node:fs/promises";
import * as OS from "node:os";
import * as Path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { computeFullDiffFromIndexFiles } from "../fullDiffWorkerRuntime";
import { indexFilePath, initScanIndex, openIndexWriter } from "../scanIndex";

let tempDir: string;

beforeEach(async () => {
  tempDir = await FSP.mkdtemp(Path.join(OS.tmpdir(), "diskhound-full-diff-worker-"));
  initScanIndex(tempDir);
});

afterEach(async () => {
  await FSP.rm(tempDir, { recursive: true, force: true });
});

async function writeIndex(
  id: string,
  lines: Array<Record<string, unknown> | string>,
): Promise<string> {
  const filePath = indexFilePath(id);
  const { stream, finalize } = openIndexWriter(filePath);

  for (const line of lines) {
    stream.write(typeof line === "string" ? line : `${JSON.stringify(line)}\n`);
  }

  await finalize();
  return filePath;
}

describe("computeFullDiffFromIndexFiles", () => {
  it("computes a full diff while keeping only the smaller side in memory", async () => {
    const baselinePath = await writeIndex("baseline", [
      { p: "C:\\alpha.bin", s: 100, m: 1 },
      { p: "C:\\beta.bin", s: 1000, m: 1 },
      { p: "C:\\gone.log", s: 500, m: 1 },
    ]);

    const currentPath = await writeIndex("current", [
      { p: "C:\\alpha.bin", s: 100, m: 2 },
      { p: "C:\\beta.bin", s: 3000, m: 2 },
      { p: "C:\\new.iso", s: 7000, m: 2 },
    ]);

    const result = await computeFullDiffFromIndexFiles({
      baselineId: "baseline",
      currentId: "current",
      baselinePath,
      currentPath,
      limit: 10,
      caseSensitive: false,
    });

    expect(result).not.toBeNull();
    expect(result?.totalChanges).toBe(3);
    expect(result?.totalAdded).toBe(1);
    expect(result?.totalRemoved).toBe(1);
    expect(result?.totalGrew).toBe(1);
    expect(result?.totalShrank).toBe(0);
    expect(result?.totalBytesAdded).toBe(9000);
    expect(result?.totalBytesRemoved).toBe(500);
    expect(result?.changes.map((change) => [change.path, change.kind])).toEqual([
      ["C:\\new.iso", "added"],
      ["C:\\beta.bin", "grew"],
      ["C:\\gone.log", "removed"],
    ]);
  });

  it("ignores malformed lines and directory records", async () => {
    const baselinePath = await writeIndex("baseline-noisy", [
      { p: "C:\\folder", t: "d", m: 1 },
      { p: "C:\\same.txt", s: 100, m: 1 },
      "this is not json\n",
    ]);

    const currentPath = await writeIndex("current-noisy", [
      { p: "C:\\folder", t: "d", m: 2 },
      { p: "C:\\same.txt", s: 100, m: 2 },
      { p: "C:\\new.txt", s: 50, m: 2 },
    ]);

    const result = await computeFullDiffFromIndexFiles({
      baselineId: "baseline-noisy",
      currentId: "current-noisy",
      baselinePath,
      currentPath,
      caseSensitive: false,
    });

    expect(result?.totalChanges).toBe(1);
    expect(result?.changes[0]).toMatchObject({
      path: "C:\\new.txt",
      kind: "added",
      deltaBytes: 50,
    });
  });

  it("caps the returned changes while preserving totals", async () => {
    const baselinePath = await writeIndex("baseline-limit", []);
    const currentPath = await writeIndex(
      "current-limit",
      Array.from({ length: 8 }, (_, index) => ({
        p: `C:\\file-${index}.bin`,
        s: (index + 1) * 100,
        m: index + 1,
      })),
    );

    const result = await computeFullDiffFromIndexFiles({
      baselineId: "baseline-limit",
      currentId: "current-limit",
      baselinePath,
      currentPath,
      limit: 3,
      caseSensitive: false,
    });

    expect(result?.totalChanges).toBe(8);
    expect(result?.changes).toHaveLength(3);
    expect(result?.truncated).toBe(true);
    expect(result?.changes.map((change) => change.path)).toEqual([
      "C:\\file-7.bin",
      "C:\\file-6.bin",
      "C:\\file-5.bin",
    ]);
  });

  it("supports case-sensitive and case-insensitive diffing explicitly", async () => {
    const baselinePath = await writeIndex("baseline-case", [
      { p: "/tmp/Readme.md", s: 10, m: 1 },
    ]);
    const currentPath = await writeIndex("current-case", [
      { p: "/tmp/readme.md", s: 20, m: 2 },
    ]);

    const insensitive = await computeFullDiffFromIndexFiles({
      baselineId: "baseline-case",
      currentId: "current-case",
      baselinePath,
      currentPath,
      caseSensitive: false,
    });
    expect(insensitive?.totalChanges).toBe(1);
    expect(insensitive?.changes[0]).toMatchObject({
      kind: "grew",
      path: "/tmp/readme.md",
      previousSize: 10,
      size: 20,
    });

    const sensitive = await computeFullDiffFromIndexFiles({
      baselineId: "baseline-case",
      currentId: "current-case",
      baselinePath,
      currentPath,
      caseSensitive: true,
    });
    expect(sensitive?.totalChanges).toBe(2);
    expect(sensitive?.totalAdded).toBe(1);
    expect(sensitive?.totalRemoved).toBe(1);
  });

  it("returns null when neither index exists", async () => {
    const result = await computeFullDiffFromIndexFiles({
      baselineId: "missing-a",
      currentId: "missing-b",
      baselinePath: Path.join(tempDir, "scan-indexes", "missing-a.ndjson.gz"),
      currentPath: Path.join(tempDir, "scan-indexes", "missing-b.ndjson.gz"),
      caseSensitive: false,
    });

    expect(result).toBeNull();
  });
});
