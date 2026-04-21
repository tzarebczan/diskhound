import * as FSP from "node:fs/promises";
import * as OS from "node:os";
import * as Path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { FullDiffResult } from "../contracts";
import {
  deleteFullDiffCachesForScan,
  fullDiffCachePath,
  hasFullDiffCache,
  initFullDiffCacheStore,
  readFullDiffCache,
  writeFullDiffCache,
} from "../fullDiffCacheStore";

let tempDir: string;

const sampleResult: FullDiffResult = {
  baselineId: "scan-a",
  currentId: "scan-b",
  totalChanges: 1,
  totalAdded: 1,
  totalRemoved: 0,
  totalGrew: 0,
  totalShrank: 0,
  totalBytesAdded: 42,
  totalBytesRemoved: 0,
  changes: [
    {
      path: "C:\\example.txt",
      kind: "added",
      size: 42,
      previousSize: 0,
      deltaBytes: 42,
    },
  ],
  truncated: false,
};

beforeEach(async () => {
  tempDir = await FSP.mkdtemp(Path.join(OS.tmpdir(), "diskhound-full-diff-cache-test-"));
  initFullDiffCacheStore(tempDir);
});

afterEach(async () => {
  await FSP.rm(tempDir, { recursive: true, force: true });
});

describe("fullDiffCacheStore", () => {
  it("writes and reads a cached full diff", async () => {
    await writeFullDiffCache(sampleResult, 1000);

    await expect(hasFullDiffCache("scan-a", "scan-b", 1000)).resolves.toBe(true);
    await expect(readFullDiffCache("scan-a", "scan-b", 1000)).resolves.toEqual(sampleResult);
  });

  it("deletes every cached diff that references a pruned scan id", async () => {
    await writeFullDiffCache(sampleResult, 1000);
    await writeFullDiffCache({
      ...sampleResult,
      baselineId: "scan-c",
      currentId: "scan-a",
    }, 500);
    await writeFullDiffCache({
      ...sampleResult,
      baselineId: "scan-x",
      currentId: "scan-y",
    }, 500);

    await deleteFullDiffCachesForScan("scan-a");

    await expect(hasFullDiffCache("scan-a", "scan-b", 1000)).resolves.toBe(false);
    await expect(hasFullDiffCache("scan-c", "scan-a", 500)).resolves.toBe(false);
    await expect(FSP.access(fullDiffCachePath("scan-x", "scan-y", 500))).resolves.toBeUndefined();
  });
});
