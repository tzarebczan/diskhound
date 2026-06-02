import { describe, expect, it } from "vitest";

import { deriveProcessMetadata } from "../processMonitor";

describe("deriveProcessMetadata", () => {
  it("summarizes node commands and infers project roots from node_modules paths", () => {
    const metadata = deriveProcessMetadata({
      name: "node.exe",
      exePath: "C:\\Program Files\\nodejs\\node.exe",
      commandLine:
        "\"C:\\Program Files\\nodejs\\node.exe\" \"C:\\Users\\thoma\\repo\\app\\node_modules\\vite\\bin\\vite.js\" --host 127.0.0.1",
    });

    expect(metadata.commandPreview).toContain("vite.js");
    expect(metadata.commandPreview).toContain("--host 127.0.0.1");
    expect(metadata.workingDirectory).toBe("C:\\Users\\thoma\\repo\\app");
  });

  it("uses explicit cwd-style options when present", () => {
    const metadata = deriveProcessMetadata({
      name: "node.exe",
      exePath: "C:\\Program Files\\nodejs\\node.exe",
      commandLine: "\"C:\\Program Files\\nodejs\\node.exe\" --cwd C:\\Users\\thoma\\repo\\api server.js",
    });

    expect(metadata.workingDirectory).toBe("C:\\Users\\thoma\\repo\\api");
  });

  it("does not treat Windows slash-style switches as working directories", () => {
    const metadata = deriveProcessMetadata({
      name: "chrome.exe",
      exePath: "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
      commandLine:
        "\"C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe\" --type=renderer /prefetch:1",
    });

    expect(metadata.commandPreview).toContain("--type=renderer");
    expect(metadata.workingDirectory).toBeNull();
  });
});
