import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { Worker } from "node:worker_threads";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, "..");
const args = process.argv.slice(2);

const rootFlagIndex = args.indexOf("--root");
if (rootFlagIndex === -1 || !args[rootFlagIndex + 1]) {
  console.error("Usage: node scripts/benchmark-scan.mjs --root <path>");
  process.exit(1);
}

const rootPath = resolve(args[rootFlagIndex + 1]);
const options = {
  skipHidden: !args.includes("--include-hidden"),
  excludeCommonJunk: !args.includes("--include-junk"),
};

const workerEntry = join(projectRoot, "dist-electron", "scan", "scanWorker.cjs");
const nativeReleaseEntry = join(
  projectRoot,
  "native",
  "diskhound-native-scanner",
  "target",
  "release",
  process.platform === "win32" ? "diskhound-native-scanner.exe" : "diskhound-native-scanner",
);

if (!existsSync(workerEntry)) {
  console.error(`Missing ${workerEntry}. Run "bun run build" first.`);
  process.exit(1);
}

const rows = [];

rows.push(await runJsWorkerBenchmark());
if (existsSync(nativeReleaseEntry)) {
  rows.push(await runNativeBenchmark());
}

printTable(rows);

async function runJsWorkerBenchmark() {
  const startedAt = performance.now();

  return await new Promise((resolvePromise, reject) => {
    const worker = new Worker(workerEntry);

    worker.once("error", reject);
    worker.on("message", async (message) => {
      if (message.type !== "done") {
        return;
      }

      await worker.terminate();
      resolvePromise({
        engine: "js-worker",
        elapsedMs: Math.round(performance.now() - startedAt),
        filesVisited: message.snapshot.filesVisited,
        directoriesVisited: message.snapshot.directoriesVisited,
        bytesSeen: message.snapshot.bytesSeen,
      });
    });

    worker.postMessage({
      type: "start",
      input: { rootPath, options },
    });
  });
}

async function runNativeBenchmark() {
  const startedAt = performance.now();
  const nativeArgs = ["--root", rootPath];
  if (options.skipHidden) {
    nativeArgs.push("--skip-hidden");
  }
  if (options.excludeCommonJunk) {
    nativeArgs.push("--exclude-common-junk");
  }

  return await new Promise((resolvePromise, reject) => {
    const child = spawn(nativeReleaseEntry, nativeArgs, {
      cwd: projectRoot,
      stdio: ["ignore", "pipe", "pipe"],
    });

    child.stdout.setEncoding("utf8");

    let stdoutBuffer = "";
    let stderrBuffer = "";

    child.stdout.on("data", (chunk) => {
      stdoutBuffer += chunk;
      const lines = stdoutBuffer.split(/\r?\n/);
      stdoutBuffer = lines.pop() ?? "";

      for (const line of lines) {
        if (!line.trim()) {
          continue;
        }

        const message = JSON.parse(line);
        if (message.type !== "done") {
          continue;
        }

        resolvePromise({
          engine: "native-sidecar",
          elapsedMs: Math.round(performance.now() - startedAt),
          filesVisited: message.snapshot.filesVisited,
          directoriesVisited: message.snapshot.directoriesVisited,
          bytesSeen: message.snapshot.bytesSeen,
        });
      }
    });

    child.stderr.on("data", (chunk) => {
      stderrBuffer += chunk;
    });

    child.once("error", reject);
    child.once("exit", (code) => {
      if (code !== 0) {
        reject(new Error(stderrBuffer || `Native scanner exited with code ${code}.`));
      }
    });
  });
}

function printTable(records) {
  console.log(`Benchmark root: ${rootPath}`);
  console.log(`Options: skipHidden=${options.skipHidden}, excludeCommonJunk=${options.excludeCommonJunk}`);
  console.log("");

  const engineWidth = Math.max(...records.map((record) => record.engine.length), "engine".length);
  const elapsedWidth = Math.max(...records.map((record) => String(record.elapsedMs).length), "ms".length);
  const filesWidth = Math.max(...records.map((record) => String(record.filesVisited).length), "files".length);
  const dirsWidth = Math.max(...records.map((record) => String(record.directoriesVisited).length), "dirs".length);
  const bytesWidth = Math.max(...records.map((record) => String(record.bytesSeen).length), "bytes".length);

  const header =
    `${pad("engine", engineWidth)}  ${pad("ms", elapsedWidth)}  ${pad("files", filesWidth)}  ${pad("dirs", dirsWidth)}  ${pad("bytes", bytesWidth)}`;
  console.log(header);
  console.log("-".repeat(header.length));

  for (const record of records) {
    console.log(
      `${pad(record.engine, engineWidth)}  ${pad(String(record.elapsedMs), elapsedWidth)}  ${pad(String(record.filesVisited), filesWidth)}  ${pad(String(record.directoriesVisited), dirsWidth)}  ${pad(String(record.bytesSeen), bytesWidth)}`,
    );
  }
}

function pad(value, length) {
  return value.padEnd(length, " ");
}
