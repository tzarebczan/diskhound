import { defineConfig } from "tsdown";

const shared = {
  format: "cjs" as const,
  outDir: "dist-electron",
  sourcemap: true,
  outExtensions: () => ({ js: ".cjs" }),
  // blake2 is a native addon (vrza/node-blake2) — keep it external so
  // the bundler doesn't try to inline the require, and so the runtime
  // resolves it from node_modules/blake2/ at load time (which is
  // app.asar.unpacked/node_modules/blake2/ once electron-builder runs).
  external: ["electron", "electron-updater", "blake2"],
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
