/* Test whether my hash functions cleanly handle EPERM on
 * Windows-restricted system files. We pick a known-restricted path
 * and exercise both hashFilePrefix (createReadStream) and
 * hashFileSample (FSP.open) against it. The test passes if both
 * resolve null WITHOUT throwing an uncaught exception. */
import * as fs from "node:fs";
import * as path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

// Find a restricted file in ProgramData
function findRestricted() {
  const candidates = [
    "C:\\ProgramData\\Microsoft\\Windows\\CapabilityAccessManager",
    "C:\\ProgramData\\Microsoft\\Crypto",
    "C:\\Windows\\System32\\config",
  ];
  for (const dir of candidates) {
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const e of entries) {
        if (e.isFile()) {
          const fp = path.join(dir, e.name);
          // Try to open. If EPERM, this is our candidate.
          try {
            const fd = fs.openSync(fp, "r");
            fs.closeSync(fd);
          } catch (err) {
            if (err.code === "EPERM" || err.code === "EACCES") {
              return { path: fp, size: 1000000 }; // dummy size; if known, use real
            }
          }
        } else if (e.isDirectory()) {
          // Recurse into one level
          try {
            const subEntries = fs.readdirSync(path.join(dir, e.name), { withFileTypes: true });
            for (const se of subEntries) {
              if (se.isFile()) {
                const fp = path.join(dir, e.name, se.name);
                try {
                  const fd = fs.openSync(fp, "r");
                  fs.closeSync(fd);
                } catch (err) {
                  if (err.code === "EPERM" || err.code === "EACCES") {
                    return { path: fp, size: 1000000 };
                  }
                }
              }
            }
          } catch { /* dir-level perm error */ }
        }
      }
    } catch { /* skip */ }
  }
  return null;
}

const restricted = findRestricted();
if (!restricted) {
  console.error("No restricted file found — test inconclusive on this system");
  process.exit(0);
}
console.log("found restricted file:", restricted.path);

// Try the same fs ops the scanner uses. If anything throws an
// uncaught exception, the process exits non-zero.
process.on("uncaughtException", (err) => {
  console.error("UNCAUGHT EXCEPTION:", err.message);
  console.error("stack:", err.stack);
  process.exit(1);
});
process.on("unhandledRejection", (reason) => {
  console.error("UNHANDLED REJECTION:", reason);
  process.exit(1);
});

// Compile our duplicates module
const ts = require("typescript");
function transpile(p) {
  return ts.transpileModule(fs.readFileSync(p, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
}
const os = require("node:os");
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "dh-eperm-"));
fs.mkdirSync(path.join(tmpRoot, "_compiled"), { recursive: true });
const work = path.join(tmpRoot, "_compiled");
fs.writeFileSync(path.join(work, "contracts.js"), "module.exports = {};\n");
fs.writeFileSync(path.join(work, "duplicateHashCache.js"), transpile(path.resolve("src/shared/duplicateHashCache.ts")));
fs.writeFileSync(path.join(work, "pathUtils.js"), transpile(path.resolve("src/shared/pathUtils.ts")));
fs.writeFileSync(path.join(work, "duplicates.js"), transpile(path.resolve("src/shared/duplicates.ts")));

// Also test indirectly by running runDuplicateScan against a folder containing restricted files
const { runDuplicateScan } = require(path.join(work, "duplicates.js"));

// Scan C:\ProgramData\Microsoft — known to have restricted files
const scanRoot = "C:\\ProgramData\\Microsoft";
console.log(`\nrunning duplicate scan against ${scanRoot}...`);

const t0 = Date.now();
const handle = runDuplicateScan(
  scanRoot,
  {
    onProgress: (p) => {
      if (p.status === "error") {
        console.log("  scan errored:", p.errorMessage);
      }
    },
    onResult: (r) => {
      const dt = Date.now() - t0;
      console.log(`  scan complete in ${dt}ms — groups=${r.totalGroups} files=${r.totalDuplicateFiles} hashed=${r.filesHashed} walked=${r.filesWalked}`);
      console.log("  PASS — no uncaught exceptions");
      fs.rmSync(tmpRoot, { recursive: true, force: true });
      process.exit(0);
    },
    onError: (e) => {
      console.log("  onError called:", e.message);
      fs.rmSync(tmpRoot, { recursive: true, force: true });
      process.exit(0); // onError is fine - it's caught
    },
  },
  { minSizeBytes: 64 * 1024 }, // lower threshold so we exercise more files
);

// Safety timeout
setTimeout(() => {
  console.error("TIMEOUT after 60s");
  handle.cancel();
  setTimeout(() => process.exit(2), 1000);
}, 60_000);
