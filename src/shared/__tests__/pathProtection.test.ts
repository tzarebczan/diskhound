import { describe, expect, it } from "vitest";

import {
  findExcludedFolderActionBlocker,
  findExcludedFolderForPath,
  findNestedExcludedFolderForPath,
  getDefaultExcludedFolderPaths,
  isHiddenExcludedPath,
  isPathExcluded,
  isPathInsideFolder,
  isVisibleProtectedFolderByDefault,
  normalizeExcludedFolderPaths,
  normalizeProtectionPath,
  parentFolderOfPath,
  protectedFolderDisplayName,
} from "../pathProtection";

describe("path protection helpers", () => {
  it("normalizes Windows paths for case-insensitive folder matching", () => {
    expect(normalizeProtectionPath("C:/Windows/System32/", "win32")).toBe("c:\\windows\\system32");
    expect(isPathInsideFolder("C:\\Windows\\System32\\cmd.exe", "c:\\windows", "win32")).toBe(true);
    expect(isPathInsideFolder("C:\\WindowShadow\\x.dat", "C:\\Windows", "win32")).toBe(false);
  });

  it("uses separator-aware matching on POSIX paths", () => {
    expect(isPathInsideFolder("/usr/bin/python", "/usr", "linux")).toBe(true);
    expect(isPathInsideFolder("/usr_local/bin/tool", "/usr", "linux")).toBe(false);
  });

  it("deduplicates excluded folder paths by normalized comparison", () => {
    expect(normalizeExcludedFolderPaths([
      "C:\\Windows\\",
      "c:/windows",
      "C:\\ProgramData",
    ], "win32")).toEqual(["C:\\Windows", "C:\\ProgramData"]);
  });

  it("returns the most specific matching excluded folder", () => {
    const match = findExcludedFolderForPath(
      "C:\\Windows\\System32\\drivers\\etc\\hosts",
      ["C:\\Windows", "C:\\Windows\\System32"],
      "win32",
    );
    expect(match).toBe("C:\\Windows\\System32");
  });

  it("finds protected folders nested under a destructive action target", () => {
    const match = findNestedExcludedFolderForPath(
      "C:\\Users\\thoma",
      ["C:\\Users\\thoma\\AppData", "C:\\Windows"],
      "win32",
    );
    expect(match).toBe("C:\\Users\\thoma\\AppData");
  });

  it("reports whether an action is inside or contains a protected folder", () => {
    expect(findExcludedFolderActionBlocker(
      "C:\\Windows\\System32\\cmd.exe",
      ["C:\\Windows"],
      "win32",
    )).toEqual({ folder: "C:\\Windows", reason: "inside" });

    expect(findExcludedFolderActionBlocker(
      "C:\\Users\\thoma",
      ["C:\\Users\\thoma\\AppData"],
      "win32",
    )).toEqual({ folder: "C:\\Users\\thoma\\AppData", reason: "contains" });
  });

  it("keeps useful protected space buckets visible while hiding stricter system folders", () => {
    const excluded = ["C:\\Windows", "C:\\ProgramData", "C:\\$Recycle.Bin"];

    expect(isHiddenExcludedPath("C:\\Windows\\System32", excluded, "win32")).toBe(true);
    expect(isHiddenExcludedPath("C:\\ProgramData\\Vendor\\cache.bin", excluded, "win32")).toBe(false);
    expect(isHiddenExcludedPath("C:\\$Recycle.Bin\\S-1-5-21\\$R123.bin", excluded, "win32")).toBe(false);
    expect(isPathExcluded("C:\\ProgramData\\Vendor\\cache.bin", excluded, "win32")).toBe(false);
    expect(findExcludedFolderForPath("C:\\ProgramData\\Vendor\\cache.bin", excluded, "win32")).toBe("C:\\ProgramData");
    expect(findExcludedFolderActionBlocker("C:\\$Recycle.Bin\\S-1-5-21\\$R123.bin", excluded, "win32")).toEqual({
      folder: "C:\\$Recycle.Bin",
      reason: "inside",
    });
    expect(isVisibleProtectedFolderByDefault("C:\\ProgramData", "win32")).toBe(true);
    expect(protectedFolderDisplayName("C:\\$Recycle.Bin", "win32")).toBe("Recycle Bin");
    expect(protectedFolderDisplayName("C:\\$Recycle.Bin\\S-1-5-21", "win32")).toBe(null);
  });

  it("derives parent folders without dropping drive roots", () => {
    expect(parentFolderOfPath("C:\\Windows\\notepad.exe")).toBe("C:\\Windows");
    expect(parentFolderOfPath("C:\\Windows")).toBe("C:\\");
    expect(parentFolderOfPath("/usr/bin/python")).toBe("/usr/bin");
  });

  it("provides platform defaults", () => {
    expect(getDefaultExcludedFolderPaths("win32")).toContain("C:\\Windows");
    expect(getDefaultExcludedFolderPaths("darwin")).toContain("/System");
    expect(getDefaultExcludedFolderPaths("linux")).toContain("/usr");
  });
});
