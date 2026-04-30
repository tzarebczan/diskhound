import { describe, expect, it } from "vitest";

import { parseMacDfOutput } from "../diskMonitor";

describe("parseMacDfOutput", () => {
  it("keeps the startup disk and mounted user volumes", () => {
    const stdout = [
      "Filesystem   1024-blocks      Used Available Capacity Mounted on",
      "/dev/disk3s1s1 488245288  12345678 123456789    10% /",
      "/dev/disk3s5   488245288  23456789 123456789    16% /System/Volumes/Data",
      "/dev/disk4s1   976490576 400000000 576490576    41% /Volumes/Archive",
      "//nas/media    1952981152 500000000 1452981152   26% /Volumes/Media Share",
    ].join("\n");

    const drives = parseMacDfOutput(stdout, 123);

    expect(drives.map((drive) => drive.drive)).toEqual([
      "/",
      "/Volumes/Archive",
      "/Volumes/Media Share",
    ]);
    expect(drives[0]).toMatchObject({
      totalBytes: 488245288 * 1024,
      usedBytes: 12345678 * 1024,
      freeBytes: 123456789 * 1024,
      timestamp: 123,
    });
  });

  it("filters macOS virtual volumes and zero-sized filesystems", () => {
    const stdout = [
      "Filesystem   1024-blocks Used Available Capacity Mounted on",
      "devfs               190  190         0   100% /dev",
      "/dev/disk3s2  488245288 100 488245188     1% /System/Volumes/Preboot",
      "/dev/disk3s4          0   0         0   100% /private/var/vm",
    ].join("\n");

    expect(parseMacDfOutput(stdout)).toEqual([]);
  });
});
