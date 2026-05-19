/* Stress-test the duplicate scanner against a realistic file mix.
 *
 * Builds a tree of N duplicate pairs across a few size buckets +
 * lots of unique distractors, then verifies the scan returns
 * exactly N groups. Optionally hammers the index path AND
 * exercises a cancel-mid-scan to verify cancellation. */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as zlib from "node:zlib";
import { randomBytes } from "node:crypto";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "dh-dup-test-"));
const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), "dh-dup-cache-"));
console.log("tmp:", tmpRoot);

// Build tree. Many small dup pairs + a few large dup pairs + unique
// distractors of every size.
console.log("building tree...");
const expectedGroups = new Set(); // hash-equivalent keys
const sizeBuckets = [
  { name: "2k", size: 2 * 1024 },           // below min size, ignored
  { name: "1.5m", size: 1.5 * 1024 * 1024 }, // above min, full-hashed
  { name: "5m", size: 5 * 1024 * 1024 },     // full-hashed
  { name: "70m", size: 70 * 1024 * 1024 },   // sample-hashed
];

for (const { name, size } of sizeBuckets) {
  const dir = path.join(tmpRoot, `bucket-${name}`);
  fs.mkdirSync(dir, { recursive: true });
  // 3 duplicate pairs per bucket — each pair shares random content
  for (let pair = 0; pair < 3; pair++) {
    const content = randomBytes(Math.round(size));
    const a = path.join(dir, `pair-${pair}-a.bin`);
    const b = path.join(dir, `pair-${pair}-b.bin`);
    fs.writeFileSync(a, content);
    fs.writeFileSync(b, content);
    if (size >= 1024 * 1024) {
      // Only bucks above min size should produce groups
      expectedGroups.add(`${Math.round(size)}:${pair}`);
    }
  }
  // 5 unique distractors per bucket — same size, different content
  for (let d = 0; d < 5; d++) {
    const content = randomBytes(Math.round(size));
    fs.writeFileSync(path.join(dir, `unique-${d}.bin`), content);
  }
}

const allFiles = [];
const walk = (d) => {
  for (const f of fs.readdirSync(d)) {
    const fp = path.join(d, f);
    const st = fs.statSync(fp);
    if (st.isDirectory()) walk(fp);
    else allFiles.push({ path: fp, size: st.size, mtime: st.mtimeMs });
  }
};
walk(tmpRoot);
console.log(`tree: ${allFiles.length} files`);
console.log(`expected groups: ${expectedGroups.size} (only above 1MB)`);

// Build an index
const indexPath = path.join(tmpRoot, "_idx.ndjson.gz");
const records = [{ p: tmpRoot, t: "d" }];
for (const f of allFiles) records.push({ p: f.path, s: f.size, m: Math.floor(f.mtime) });
fs.writeFileSync(indexPath, zlib.gzipSync(Buffer.from(records.map(JSON.stringify).join("\n") + "\n")));

// Compile TS
const ts = require("typescript");
function transpile(p) {
  return ts.transpileModule(fs.readFileSync(p, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
}
const work = path.join(tmpRoot, "_compiled");
fs.mkdirSync(work, { recursive: true });
fs.writeFileSync(path.join(work, "contracts.js"), "module.exports = {};\n");
fs.writeFileSync(path.join(work, "duplicateHashCache.js"), transpile(path.resolve("src/shared/duplicateHashCache.ts")));
fs.writeFileSync(path.join(work, "pathUtils.js"), transpile(path.resolve("src/shared/pathUtils.ts")));
fs.writeFileSync(path.join(work, "duplicates.js"), transpile(path.resolve("src/shared/duplicates.ts")));
const { runDuplicateScan } = require(path.join(work, "duplicates.js"));

function scenario(name, options) {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    let lastProg = "";
    let progCount = 0;
    const handle = runDuplicateScan(
      tmpRoot,
      {
        onProgress: (p) => {
          progCount++;
          lastProg = `${p.status} walked=${p.filesWalked} cand=${p.candidateGroups} hashed=${p.filesHashed} conf=${p.groupsConfirmed}`;
        },
        onResult: (r) => {
          const dt = Date.now() - t0;
          console.log(`  [${name}] ${dt}ms — ${progCount} progress events — last: ${lastProg}`);
          console.log(`  [${name}] RESULT groups=${r.totalGroups} files=${r.totalDuplicateFiles} wasted=${r.totalWastedBytes}B hashed=${r.filesHashed}`);
          if (r.totalGroups !== expectedGroups.size) {
            reject(new Error(`expected ${expectedGroups.size} groups, got ${r.totalGroups}`));
            return;
          }
          resolve();
        },
        onError: (e) => reject(e),
      },
      options,
    );
    void handle;
  });
}

async function main() {
  console.log("\n=== walk path, cold cache ===");
  await scenario("walk", { cacheDir });
  console.log("\n=== walk path, warm cache ===");
  await scenario("walk2", { cacheDir });
  console.log("\n=== index path, warm cache ===");
  await scenario("index", { indexPath, cacheDir });

  // Cancel mid-scan test
  console.log("\n=== cancel mid-scan ===");
  await new Promise((resolve) => {
    let progressCount = 0;
    let lastStatus = "";
    let resultFired = false;
    let cancelEventSeen = false;
    const t0 = Date.now();
    const handle = runDuplicateScan(
      tmpRoot,
      {
        onProgress: (p) => {
          progressCount++;
          lastStatus = p.status;
          if (p.status === "cancelled") cancelEventSeen = true;
          if (progressCount === 3) {
            const t1 = Date.now();
            console.log(`  cancelling at progress #${progressCount} (${t1 - t0}ms in)`);
            handle.cancel();
            const t2 = Date.now();
            console.log(`  cancel() returned in ${t2 - t1}ms`);
            setTimeout(() => {
              console.log(`  300ms after cancel: ${progressCount} total progress events, lastStatus=${lastStatus}, cancelEventSeen=${cancelEventSeen}, resultFired=${resultFired}`);
              if (resultFired) {
                console.error("  FAIL: result fired after cancel");
                process.exit(1);
              }
              if (!cancelEventSeen) {
                console.error("  FAIL: never saw cancelled status event");
                process.exit(1);
              }
              resolve();
            }, 300);
          }
        },
        onResult: () => { resultFired = true; },
        onError: (e) => console.log(`  error: ${e.message}`),
      },
      { cacheDir },
    );
  });

  console.log("\nALL OK");
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  fs.rmSync(cacheDir, { recursive: true, force: true });
  process.exit(0);
}

setTimeout(() => { console.error("TIMEOUT"); process.exit(3); }, 60_000);
main().catch((e) => { console.error("FAIL:", e); process.exit(1); });
