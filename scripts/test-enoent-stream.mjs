/* Verify that the hashFilePrefix-style createReadStream + error
 * listener pattern actually catches ENOENT. If it doesn't, that
 * explains the user's leak. */
import { createReadStream } from "node:fs";

process.on("uncaughtException", (err) => {
  console.error("UNCAUGHT:", err.message);
  console.error("type:", typeof err, "code:", err.code, "hasStack:", !!err.stack);
  process.exit(1);
});

function hashFilePrefixLike(filePath) {
  return new Promise((resolve) => {
    let stream = null;
    try {
      stream = createReadStream(filePath, {
        start: 0,
        end: 65535,
        highWaterMark: 65536,
      });
    } catch {
      return resolve(null);
    }
    let settled = false;
    const finish = (val) => {
      if (settled) return;
      settled = true;
      try { stream.destroy(); } catch {}
      resolve(val);
    };
    stream.on("data", () => {});
    stream.on("end", () => finish("ok"));
    stream.on("error", () => finish(null));
    stream.on("close", () => { if (!settled) finish(null); });
  });
}

// Test on a non-existent file
const result = await hashFilePrefixLike("C:\\does\\not\\exist\\nope.bin");
console.log("got:", result);

// Test that 1000 in parallel doesn't leak
const tasks = [];
for (let i = 0; i < 1000; i++) {
  tasks.push(hashFilePrefixLike(`C:\\does\\not\\exist\\nope-${i}.bin`));
}
const results = await Promise.all(tasks);
console.log("1000 non-existent: all got", results[0], "+ same?", results.every(r => r === results[0]));
console.log("PASS — no uncaught");
