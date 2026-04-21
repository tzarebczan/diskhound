import { describe, expect, it } from "vitest";

import { normPath } from "../pathUtils";

describe("normPath", () => {
  it("lowercases Windows paths while trimming trailing separators", () => {
    expect(normPath("C:\\Users\\Test\\", "win32")).toBe("c:\\users\\test");
    expect(normPath("C:\\Users\\Test\\\\", "win32")).toBe("c:\\users\\test");
  });

  it("preserves case on case-sensitive platforms while trimming trailing separators", () => {
    expect(normPath("/Users/Test/", "darwin")).toBe("/Users/Test");
    expect(normPath("/tmp/Foo//", "linux")).toBe("/tmp/Foo");
  });

  it("keeps existing casing when no trailing separator is present", () => {
    expect(normPath("/Data/MixedCase", "linux")).toBe("/Data/MixedCase");
    expect(normPath("D:\\Mixed\\Case", "win32")).toBe("d:\\mixed\\case");
  });
});
