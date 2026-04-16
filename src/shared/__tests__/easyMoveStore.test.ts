import * as FS from "node:fs";
import * as FSP from "node:fs/promises";
import * as Path from "node:path";
import * as OS from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { easyMove, easyMoveBack, getEasyMoves, initEasyMoveStore } from "../easyMoveStore";

let tempDir: string;
let sourceDir: string;
let destDir: string;

beforeEach(async () => {
  tempDir = await FSP.mkdtemp(Path.join(OS.tmpdir(), "diskhound-easymove-test-"));
  sourceDir = Path.join(tempDir, "source");
  destDir = Path.join(tempDir, "dest");
  await FSP.mkdir(sourceDir, { recursive: true });
  await FSP.mkdir(destDir, { recursive: true });
  initEasyMoveStore(tempDir);
});

afterEach(async () => {
  await FSP.rm(tempDir, { recursive: true, force: true });
});

describe("easyMoveStore", () => {
  it("moves a file and creates a link at the original location", async () => {
    const filePath = Path.join(sourceDir, "test.txt");
    await FSP.writeFile(filePath, "hello world");

    const result = await easyMove(filePath, destDir);

    expect(result.ok).toBe(true);
    expect(result.record).toBeDefined();
    // Original path should exist (as a link)
    expect(FS.existsSync(filePath)).toBe(true);
    // Destination should have the file
    expect(FS.existsSync(Path.join(destDir, "test.txt"))).toBe(true);
  });

  it("records the move in the store", async () => {
    const filePath = Path.join(sourceDir, "tracked.txt");
    await FSP.writeFile(filePath, "data");

    await easyMove(filePath, destDir);

    const records = getEasyMoves();
    expect(records).toHaveLength(1);
    expect(records[0].originalPath).toBe(filePath);
    expect(records[0].movedToPath).toBe(Path.join(destDir, "tracked.txt"));
  });

  it("restores a file with easyMoveBack", async () => {
    const filePath = Path.join(sourceDir, "restore.txt");
    await FSP.writeFile(filePath, "restore me");

    const moveResult = await easyMove(filePath, destDir);
    expect(moveResult.ok).toBe(true);

    const records = getEasyMoves();
    const backResult = await easyMoveBack(records[0].id);

    expect(backResult.ok).toBe(true);
    // File should be back at original location (as a real file, not a link)
    expect(FS.existsSync(filePath)).toBe(true);
    const content = await FSP.readFile(filePath, "utf-8");
    expect(content).toBe("restore me");
    // Record should be removed
    expect(getEasyMoves()).toHaveLength(0);
  });

  it("rejects self-recursion (destination inside source)", async () => {
    const dirPath = Path.join(sourceDir, "mydir");
    await FSP.mkdir(dirPath);
    await FSP.writeFile(Path.join(dirPath, "file.txt"), "data");

    const subDest = Path.join(dirPath, "nested");
    const result = await easyMove(dirPath, subDest);

    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/recursive/i);
  });

  it("rejects when destination already exists", async () => {
    const filePath = Path.join(sourceDir, "conflict.txt");
    await FSP.writeFile(filePath, "source");
    // Create a file at the destination with the same name
    await FSP.writeFile(Path.join(destDir, "conflict.txt"), "already here");

    const result = await easyMove(filePath, destDir);

    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/already exists/i);
  });

  it("returns error for non-existent move record", async () => {
    const result = await easyMoveBack("non-existent-id");
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/not found/i);
  });

  it("persists records to disk and survives re-init", async () => {
    const filePath = Path.join(sourceDir, "persist.txt");
    await FSP.writeFile(filePath, "persistent");
    await easyMove(filePath, destDir);

    // Re-init (simulating app restart)
    initEasyMoveStore(tempDir);

    const records = getEasyMoves();
    expect(records).toHaveLength(1);
    expect(records[0].originalPath).toBe(filePath);
  });

  it("handles multiple moves correctly", async () => {
    const file1 = Path.join(sourceDir, "a.txt");
    const file2 = Path.join(sourceDir, "b.txt");
    await FSP.writeFile(file1, "aaa");
    await FSP.writeFile(file2, "bbb");

    await easyMove(file1, destDir);
    await easyMove(file2, destDir);

    expect(getEasyMoves()).toHaveLength(2);
  });
});
