import { defineConfig } from "tsdown";

const shared = {
  format: "cjs" as const,
  outDir: "dist-electron",
  sourcemap: true,
  outExtensions: () => ({ js: ".cjs" }),
  external: ["electron", "electron-updater"],
};

export default defineConfig([
  {
    ...shared,
    entry: ["src/main.ts"],
    clean: true,
  },
  {
    ...shared,
    entry: [
      "src/preload.ts",
      "src/scan/scanWorker.ts",
      "src/scan/fullDiffWorker.ts",
      "src/scan/folderTreeWorker.ts",
    ],
  },
]);
